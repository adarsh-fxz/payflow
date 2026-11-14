import "./helpers/env";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/db";
import { applyLogs } from "@/lib/server/indexer";
import { applyChainState } from "@/lib/server/runsync";
import { createOrg } from "@/lib/server/orgs";
import { createRun, loadItems, runDetail, runPlan } from "@/lib/server/runs";
import { sendExpiryReminders } from "@/lib/server/reminders";
import { dashboardStats, recipientsReportStream, reportsSummary } from "@/lib/server/dashboard";
import type { RunRow } from "@/lib/server/dto";
import type { ChainLog, ChainPayment, ChainRun } from "@/lib/server/chain";
import type { OrgRow } from "@/lib/server/authz";
import { ApiHttpError } from "@/lib/server/http";
import { freshDb } from "./helpers/db";
import { log, nextTx } from "./helpers/logs";

const OWNER = "0xaaaa000000000000000000000000000000000011";
const APPROVER = "0xaaaa000000000000000000000000000000000012";
const R1 = "0xbbbb000000000000000000000000000000000011";
const R2 = "0xbbbb000000000000000000000000000000000012";
const ATTACKER = "0xeeee000000000000000000000000000000000066";
const E18 = 10n ** 18n;

const chainRun = (o: Partial<ChainRun>): ChainRun => ({
  orgId: 1n, runRef: "0x00", paymentsHash: "0x00", creator: OWNER, funder: OWNER, status: 5, approvalsRequired: 1, approvals: 1,
  paymentCount: 2, claimedCount: 0, claimWindow: 30 * 86400, createdAt: 0n, fundedAt: 0n, publishedAt: 0n, claimDeadline: 0n,
  allocated: 150n * E18, funded: 150n * E18, claimed: 0n, refunded: 0n, ...o,
});

async function setupOrg(db: Db, name: string, chainOrgId: bigint): Promise<OrgRow> {
  const org = await createOrg(db, OWNER, { name, description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 30, email: "owner@example.com" });
  await applyLogs(db, [
    log("registry", "OrganizationCreated", { orgId: chainOrgId, owner: OWNER, metadataHash: org.metadataHash }, nextTx(), 0),
    log("registry", "MemberRolesSet", { orgId: chainOrgId, member: APPROVER, roles: 2, by: OWNER }, nextTx(), 0),
  ]);
  return (await db.query<OrgRow>(`SELECT * FROM organizations WHERE id = $1`, [org.id]))[0]!;
}

async function newRun(db: Db, org: OrgRow, items: { name: string; wallet: string; amount: bigint; email?: string; description?: string }[]): Promise<RunRow> {
  const d = await createRun(db, OWNER, org, {
    name: "November payroll", paymentCategory: "salary", frequency: "one_time", scheduledAt: null, claimWindowDays: 30,
    items: items.map((i) => ({ recipientId: null, name: i.name, email: i.email ?? null, department: null, walletAddress: i.wallet as `0x${string}`, amount: i.amount.toString(), description: i.description ?? "" })),
  });
  return (await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [d.id]))[0]!;
}

const reload = async (db: Db, id: string) => (await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [id]))[0]!;

describe("lifecycle notifications are event-driven (sync before indexing)", () => {
  let db: Db;
  let org: OrgRow;
  let run: RunRow;
  const CHAIN_RUN = 21n;
  const pid = (i: number) => (CHAIN_RUN << 32n) | BigInt(i);
  let events: ChainLog[];
  const now = new Date();
  const deadline = new Date(now.getTime() + 48 * 3600_000); // inside the 72h reminder window

  beforeAll(async () => {
    db = await freshDb();
    org = await setupOrg(db, "Order Co", 1n);
    run = await newRun(db, org, [
      { name: "Alice", wallet: R1, amount: 100n * E18, email: "alice@example.com" },
      { name: "Bob", wallet: R2, amount: 50n * E18 },
    ]);
    await applyLogs(db, [log("escrow", "RunCreated", { runId: CHAIN_RUN, orgId: 1n, runRef: run.run_ref, creator: OWNER, claimWindow: 30 * 86400 }, nextTx(), 0)]);
    const t = { alloc: nextTx(), submit: nextTx(), approve: nextTx(), fund: nextTx(), publish: nextTx() };
    events = [
      log("escrow", "PaymentAllocated", { paymentId: pid(0), runId: CHAIN_RUN, recipient: R1, amount: 100n * E18 }, t.alloc, 0),
      log("escrow", "PaymentAllocated", { paymentId: pid(1), runId: CHAIN_RUN, recipient: R2, amount: 50n * E18 }, t.alloc, 1),
      log("escrow", "RunSubmitted", { runId: CHAIN_RUN, paymentsHash: "0x" + "11".repeat(32), paymentCount: 2, allocated: 150n * E18, approvalsRequired: 1 }, t.submit, 0),
      log("escrow", "RunApproved", { runId: CHAIN_RUN, approver: APPROVER, approvals: 1 }, t.approve, 0),
      log("escrow", "RunFunded", { runId: CHAIN_RUN, funder: OWNER, amount: 150n * E18 }, t.fund, 0),
      log("escrow", "RunPublished", { runId: CHAIN_RUN, claimDeadline: BigInt(Math.floor(deadline.getTime() / 1000)) }, t.publish, 0),
    ];
  }, 60_000);

  it("reproduces the report: chain sync marks the run published BEFORE its events are indexed", async () => {
    const payments: ChainPayment[] = [
      { recipient: R1, claimedAt: 0n, status: 1, amount: 100n * E18 },
      { recipient: R2, claimedAt: 0n, status: 1, amount: 50n * E18 },
    ];
    await applyChainState(db, await reload(db, run.id), chainRun({ claimDeadline: BigInt(Math.floor(deadline.getTime() / 1000)) }), payments);
    expect((await reload(db, run.id)).status).toBe("published");
    // The worker's reminder pass runs before the indexer catches up.
    await sendExpiryReminders(db, now);
    // Now the events arrive; moveStatus sees no transitions, but every notice must still go out.
    await applyLogs(db, events);
    await applyLogs(db, events); // replay: no-op
    await applyChainState(db, await reload(db, run.id), chainRun({ claimDeadline: BigInt(Math.floor(deadline.getTime() / 1000)) }), payments);
    await sendExpiryReminders(db, now);
  });

  it("employer notices arrive exactly once each, in lifecycle order", async () => {
    const rows = await db.query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM notifications WHERE wallet_address = $1 GROUP BY kind`,
      [OWNER],
    );
    const counts = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
    expect(counts).toMatchObject({ run_created: 1, run_awaiting_approval: 1, run_approved: 1, run_funded: 1, run_published: 1, claims_expiring: 1 });
    const order = await db.query<{ kind: string }>(
      `SELECT kind FROM notifications WHERE wallet_address = $1 AND kind IN ('run_created','run_awaiting_approval','run_approved','run_funded','run_published') ORDER BY created_at, id`,
      [OWNER],
    );
    expect(order.map((o) => o.kind)).toEqual(["run_created", "run_awaiting_approval", "run_approved", "run_funded", "run_published"]);
    // The approver (APPROVER role) gets the approval request once too.
    expect((await db.query(`SELECT 1 FROM notifications WHERE wallet_address = $1 AND kind = 'run_awaiting_approval'`, [APPROVER])).length).toBe(1);
    // The owner row carries the creator's email.
    const owner = await db.query<{ email: string | null }>(`SELECT email FROM organization_members WHERE organization_id = $1 AND wallet_address = $2`, [org.id, OWNER]);
    expect(owner[0]!.email).toBe("owner@example.com");
    expect((await db.query<{ email: string | null }>(`SELECT email FROM notifications WHERE wallet_address = $1 AND kind = 'run_funded'`, [OWNER]))[0]!.email).toBe("owner@example.com");
  });

  it("recipients get payment_available exactly once, always before any reminder", async () => {
    for (const [wallet, pidv] of [[R1, pid(0)], [R2, pid(1)]] as const) {
      const notes = await db.query<{ kind: string; link: string }>(`SELECT kind, link FROM notifications WHERE wallet_address = $1 ORDER BY created_at, id`, [wallet]);
      expect(notes.map((n) => n.kind)).toEqual(["payment_available", "payment_reminder"]);
      expect(notes[0]!.link).toBe(`/claim/${pidv}`);
    }
  });

  it("a payment_reminder is never sent when payment_available was not (or could not be) sent", async () => {
    const db2 = await freshDb();
    const org2 = await setupOrg(db2, "Reminder Co", 2n);
    const run2 = await newRun(db2, org2, [{ name: "Alice", wallet: R1, amount: 5n * E18 }]);
    // Legacy state: published + allocated in the DB, no payment_available row, deadline in 24h.
    await db2.query(`UPDATE payroll_runs SET chain_run_id = 22, status = 'published', claim_deadline = $2 WHERE id = $1`, [run2.id, new Date(now.getTime() + 24 * 3600_000)]);
    await db2.query(`UPDATE payroll_items SET payment_id = $2, claim_status = 'allocated' WHERE payroll_run_id = $1`, [run2.id, ((22n << 32n) | 0n).toString()]);
    // A second, mismatched item (chain recipient differs) must get neither notice.
    await db2.query(
      `INSERT INTO payroll_items (id, payroll_run_id, item_index, name, recipient_address, amount, payment_id, claim_status, chain_recipient_address, chain_amount)
       VALUES ($1, $2, 1, 'Bob', $3, 1, $4, 'allocated', $5, 1)`,
      [crypto.randomUUID(), run2.id, R2, ((22n << 32n) | 1n).toString(), ATTACKER],
    );
    await sendExpiryReminders(db2, now);
    const a = await db2.query<{ kind: string }>(`SELECT kind FROM notifications WHERE wallet_address = $1 ORDER BY created_at, id`, [R1]);
    expect(a.map((n) => n.kind)).toEqual(["payment_available", "payment_reminder"]);
    expect(await db2.query(`SELECT 1 FROM notifications WHERE wallet_address IN ($1, $2)`, [R2, ATTACKER])).toHaveLength(0);
    await db2.close();
  });
});

describe("B1: a redirected allocation never rewrites the reviewed item", () => {
  let db: Db;
  let org: OrgRow;
  let run: RunRow;
  const CHAIN_RUN = 31n;
  const pid = (i: number) => (CHAIN_RUN << 32n) | BigInt(i);

  beforeAll(async () => {
    db = await freshDb();
    org = await setupOrg(db, "Redirect Co", 3n);
    run = await newRun(db, org, [{ name: "Bob", wallet: R2, amount: 7n * E18, email: "bob@example.com" }]);
    await applyLogs(db, [log("escrow", "RunCreated", { runId: CHAIN_RUN, orgId: 3n, runRef: run.run_ref, creator: OWNER, claimWindow: 30 * 86400 }, nextTx(), 0)]);
  }, 60_000);

  it("indexer: keeps Bob's wallet, stores the attacker's separately and flags the run", async () => {
    const tx = nextTx();
    await applyLogs(db, [
      log("escrow", "PaymentAllocated", { paymentId: pid(0), runId: CHAIN_RUN, recipient: ATTACKER, amount: 7n * E18 }, tx, 0),
      // plus an extra payment that was never reviewed at all
      log("escrow", "PaymentAllocated", { paymentId: pid(1), runId: CHAIN_RUN, recipient: ATTACKER, amount: 1n * E18 }, tx, 1),
    ]);
    const items = await loadItems(db, run.id);
    expect(items[0]).toMatchObject({ name: "Bob", recipient_address: R2, chain_recipient_address: ATTACKER, reviewed: true });
    expect(items[1]).toMatchObject({ reviewed: false, recipient_address: ATTACKER });
    const d = await runDetail(db, await reload(db, run.id));
    expect(d.chainMismatch).toEqual([
      { index: 0, name: "Bob", reviewedRecipient: R2, reviewedAmount: (7n * E18).toString(), chainRecipient: ATTACKER, chainAmount: (7n * E18).toString(), txHash: tx },
      { index: 1, name: "Not in the reviewed draft", reviewedRecipient: "0x0000000000000000000000000000000000000000", reviewedAmount: "0", chainRecipient: ATTACKER, chainAmount: E18.toString(), txHash: tx },
    ]);
    // The approver would see Bob next to Bob's wallet in items, AND the mismatch block.
    expect(d.items[0]!.recipientAddress).toBe(R2);
  });

  it("chain sync (getPayments) does not rewrite it either", async () => {
    await applyChainState(db, await reload(db, run.id), chainRun({ status: 1, paymentCount: 2, allocated: 8n * E18, funded: 0n }), [
      { recipient: ATTACKER, claimedAt: 0n, status: 1, amount: 7n * E18 },
      { recipient: ATTACKER, claimedAt: 0n, status: 1, amount: 1n * E18 },
    ]);
    const items = await loadItems(db, run.id);
    expect(items[0]!.recipient_address).toBe(R2);
    expect((await runDetail(db, await reload(db, run.id))).chainMismatch).toHaveLength(2);
  });

  it("members are alerted once (in-app) and the dashboard shows it", async () => {
    const notes = await db.query<{ wallet_address: string; title: string }>(`SELECT wallet_address, title FROM notifications WHERE dedupe_key LIKE 'chain_mismatch:%'`);
    expect(notes.map((n) => n.wallet_address).sort()).toEqual([OWNER, APPROVER].sort());
    expect(notes[0]!.title).toMatch(/blocked/i);
    const stats = await dashboardStats(db, org.id);
    const act = stats.recentActivity.filter((a) => a.kind === "run.chain_mismatch");
    expect(act).toHaveLength(1);
    expect(act[0]!.detail).toBe("November payroll");
  });

  it("the plan (batches + approval hash) is refused with 409 chain_mismatch", async () => {
    const err = await runPlan(db, await reload(db, run.id)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiHttpError);
    expect(err).toMatchObject({ code: "chain_mismatch", status: 409 });
    expect((err as ApiHttpError).details).toHaveLength(2);
  });

  it("approvers are not asked to approve a run that a mismatch already blocks", async () => {
    await applyLogs(db, [
      log("escrow", "RunSubmitted", { runId: CHAIN_RUN, paymentsHash: "0x" + "33".repeat(32), paymentCount: 2, allocated: 8n * E18, approvalsRequired: 1 }, nextTx(), 0),
    ]);
    expect((await reload(db, run.id)).status).toBe("pending_approval");
    const asks = await db.query(`SELECT 1 FROM notifications WHERE kind = 'run_awaiting_approval' AND dedupe_key LIKE 'run_awaiting_approval:%'`);
    expect(asks).toHaveLength(0);
  });
});

describe("reports summary + recipients CSV", () => {
  it("aggregates in SQL and exports formula-safe CSV", async () => {
    const db = await freshDb();
    const org = await setupOrg(db, "Reports Co", 4n);
    const run = await newRun(db, org, [
      { name: "=HYPERLINK(\"x\")", wallet: R1, amount: 100n * E18 },
      { name: "Bob", wallet: R2, amount: 50n * E18 },
    ]);
    const C = 41n;
    const p = (i: number) => (C << 32n) | BigInt(i);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 10 * 86400);
    await applyLogs(db, [
      log("escrow", "RunCreated", { runId: C, orgId: 4n, runRef: run.run_ref, creator: OWNER, claimWindow: 30 * 86400 }, nextTx(), 0),
      log("escrow", "PaymentAllocated", { paymentId: p(0), runId: C, recipient: R1, amount: 100n * E18 }, nextTx(), 0),
      log("escrow", "PaymentAllocated", { paymentId: p(1), runId: C, recipient: R2, amount: 50n * E18 }, nextTx(), 1),
      log("escrow", "RunSubmitted", { runId: C, paymentsHash: "0x" + "22".repeat(32), paymentCount: 2, allocated: 150n * E18, approvalsRequired: 1 }, nextTx(), 0),
      log("escrow", "RunApproved", { runId: C, approver: APPROVER, approvals: 1 }, nextTx(), 0),
      log("escrow", "RunFunded", { runId: C, funder: OWNER, amount: 150n * E18 }, nextTx(), 0),
      log("escrow", "RunPublished", { runId: C, claimDeadline: deadline }, nextTx(), 0),
      log("escrow", "PaymentClaimed", { paymentId: p(0), runId: C, recipient: R1, amount: 100n * E18 }, nextTx(), 0),
    ]);
    const s = await reportsSummary(db, org.id);
    expect(s.payroll).toMatchObject({ runs: 1, publishedRuns: 1, completedRuns: 0, fundedWei: (150n * E18).toString(), claimedWei: (100n * E18).toString(), outstandingWei: (50n * E18).toString(), refundedWei: "0" });
    expect(s.unclaimed.map((u) => [u.paymentId, u.recipientAddress])).toEqual([[p(1).toString(), R2]]);
    expect(s.outstandingByRun).toEqual([{ runId: run.id, name: "November payroll", outstandingWei: (50n * E18).toString(), claimDeadline: new Date(Number(deadline) * 1000).toISOString() }]);
    const byWallet = Object.fromEntries(s.recipients.map((r) => [r.recipientAddress, r]));
    expect(byWallet[R1]).toMatchObject({ paymentCount: 1, paidWei: (100n * E18).toString(), unclaimedWei: "0" });
    expect(byWallet[R2]).toMatchObject({ paymentCount: 1, paidWei: "0", unclaimedWei: (50n * E18).toString(), lastPaidAt: null });
    expect(s.monthlyVolume).toHaveLength(12);
    const dash = await dashboardStats(db, org.id);
    expect(dash).toMatchObject({ totalClaimedWei: (100n * E18).toString(), outstandingWei: (50n * E18).toString(), refundableWei: "0", runCount: 1 });

    const csv = await new Response(recipientsReportStream(db, org.id)).text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("name,recipient_address,payment_count,paid,paid_wei,unclaimed,unclaimed_wei,last_paid_at");
    expect(lines).toHaveLength(3);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    await db.close();
  });
});
