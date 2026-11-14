import { ESCROW } from "./helpers/env";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/server/db";
import { applyLogs, runIndexerPass, getCursor } from "@/lib/server/indexer";
import { createOrg } from "@/lib/server/orgs";
import { createRun, loadItems, runDetail } from "@/lib/server/runs";
import type { RunRow } from "@/lib/server/dto";
import type { ChainLog } from "@/lib/server/chain";
import { freshDb } from "./helpers/db";
import { log, nextTx } from "./helpers/logs";

const OWNER = "0xaaaa000000000000000000000000000000000001";
const APPROVER = "0xaaaa000000000000000000000000000000000002";
const R1 = "0xbbbb000000000000000000000000000000000001";
const R2 = "0xbbbb000000000000000000000000000000000002";
const E18 = 10n ** 18n;

async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: string }>(sql, params);
  return Number(r[0]!.n);
}

describe("idempotent event indexing (PGlite, synthetic logs)", () => {
  let db: Db;
  let orgId: string;
  let run: RunRow;
  const CHAIN_RUN = 7n;
  const pid = (i: number) => (CHAIN_RUN << 32n) | BigInt(i);
  let lifecycle: ChainLog[];

  beforeAll(async () => {
    db = await freshDb();
    const org = await createOrg(db, OWNER, { name: "Acme Labs", description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 30 });
    orgId = org.id;
    await db.query(`INSERT INTO organization_members (id, organization_id, wallet_address, email, roles, status) VALUES ($1, $2, $3, 'approver@example.com', 0, 'pending')`, [crypto.randomUUID(), orgId, APPROVER]);
    const detail = await createRun(db, OWNER, (await db.query<never>(`SELECT * FROM organizations WHERE id = $1`, [orgId]))[0]!, {
      name: "November payroll",
      paymentCategory: "salary",
      frequency: "one_time",
      scheduledAt: null,
      claimWindowDays: 30,
      items: [
        { recipientId: null, name: "Alice", email: "alice@example.com", department: null, walletAddress: R1, amount: (100n * E18).toString(), description: "salary" },
        { recipientId: null, name: "Bob", email: null, department: null, walletAddress: R2, amount: (50n * E18).toString(), description: "" },
      ],
    });
    run = (await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [detail.id]))[0]!;

    const t = { org: nextTx(), member: nextTx(), create: nextTx(), alloc: nextTx(), submit: nextTx(), approve: nextTx(), fund: nextTx(), publish: nextTx() };
    lifecycle = [
      log("registry", "OrganizationCreated", { orgId: 1n, owner: OWNER, metadataHash: org.metadataHash }, t.org, 0),
      log("registry", "MemberRolesSet", { orgId: 1n, member: APPROVER, roles: 2, by: OWNER }, t.member, 0),
      log("escrow", "RunCreated", { runId: CHAIN_RUN, orgId: 1n, runRef: run.run_ref, creator: OWNER, claimWindow: 30 * 86400 }, t.create, 0),
      log("escrow", "PaymentAllocated", { paymentId: pid(0), runId: CHAIN_RUN, recipient: R1, amount: 100n * E18 }, t.alloc, 0),
      log("escrow", "PaymentAllocated", { paymentId: pid(1), runId: CHAIN_RUN, recipient: R2, amount: 50n * E18 }, t.alloc, 1),
      log("escrow", "RunSubmitted", { runId: CHAIN_RUN, paymentsHash: "0x" + "11".repeat(32), paymentCount: 2, allocated: 150n * E18, approvalsRequired: 1 }, t.submit, 0),
      log("escrow", "RunApproved", { runId: CHAIN_RUN, approver: APPROVER, approvals: 1 }, t.approve, 0),
      log("escrow", "RunFunded", { runId: CHAIN_RUN, funder: OWNER, amount: 150n * E18 }, t.fund, 0),
      log("escrow", "RunPublished", { runId: CHAIN_RUN, claimDeadline: BigInt(Math.floor(Date.parse("2026-12-01T00:00:00Z") / 1000)) }, t.publish, 0),
    ];
   }, 60_000);

  it("applies the lifecycle and maps chain ids onto DB rows", async () => {
    const r = await applyLogs(db, lifecycle);
    expect(r.applied).toBe(lifecycle.length);
    const org = (await db.query<{ status: string; chain_org_id: string }>(`SELECT status, chain_org_id FROM organizations WHERE id = $1`, [orgId]))[0]!;
    expect(org).toEqual({ status: "active", chain_org_id: "1" });
    const members = await db.query<{ wallet_address: string; roles: number; status: string }>(`SELECT wallet_address, roles, status FROM organization_members WHERE organization_id = $1 ORDER BY wallet_address`, [orgId]);
    expect(members).toEqual([
      { wallet_address: OWNER, roles: 7, status: "active" },
      { wallet_address: APPROVER, roles: 2, status: "active" },
    ]);
    const d = await runDetail(db, (await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [run.id]))[0]!);
    expect(d.status).toBe("published");
    expect(d.chainRunId).toBe("7");
    expect(d.fundedAmount).toBe((150n * E18).toString());
    expect(d.outstandingAmount).toBe((150n * E18).toString());
    expect(d.approvals.map((a) => [a.approverWallet, a.status])).toEqual([[APPROVER, "approved"]]);
    expect(d.items.map((i) => [i.paymentId, i.claimStatus])).toEqual([[pid(0).toString(), "allocated"], [pid(1).toString(), "allocated"]]);
    // payment_available: one per recipient wallet, linking to /claim/<paymentId>
    const avail = await db.query<{ wallet_address: string; link: string; email_status: string }>(`SELECT wallet_address, link, email_status FROM notifications WHERE kind = 'payment_available' ORDER BY wallet_address`);
    expect(avail).toEqual([
      { wallet_address: R1, link: `/claim/${pid(0)}`, email_status: "skipped" },
      { wallet_address: R2, link: `/claim/${pid(1)}`, email_status: "none" },
    ]);
  });

  it("replaying the same logs is a no-op (dedupe via indexed_events)", async () => {
    const before = {
      events: await count(db, `SELECT count(*)::text AS n FROM indexed_events`),
      notes: await count(db, `SELECT count(*)::text AS n FROM notifications`),
      approvals: await count(db, `SELECT count(*)::text AS n FROM payment_approvals`),
    };
    const r = await applyLogs(db, lifecycle);
    expect(r).toMatchObject({ applied: 0, skipped: lifecycle.length });
    expect(await count(db, `SELECT count(*)::text AS n FROM indexed_events`)).toBe(before.events);
    expect(await count(db, `SELECT count(*)::text AS n FROM notifications`)).toBe(before.notes);
    expect(await count(db, `SELECT count(*)::text AS n FROM payment_approvals`)).toBe(before.approvals);
  });

  it("claims reconcile totals, derive status and notify once", async () => {
    const c1 = nextTx();
    const claim1 = log("escrow", "PaymentClaimed", { paymentId: pid(0), runId: CHAIN_RUN, recipient: R1, amount: 100n * E18 }, c1, 0);
    await applyLogs(db, [claim1]);
    await applyLogs(db, [claim1]);
    let r = (await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [run.id]))[0]!;
    expect(r.status).toBe("partially_claimed");
    expect(String(r.claimed_amount)).toBe((100n * E18).toString());
    expect(r.claimed_count).toBe(1);
    expect(await count(db, `SELECT count(*)::text AS n FROM payment_claims`)).toBe(1);
    expect(await count(db, `SELECT count(*)::text AS n FROM notifications WHERE kind = 'payment_received'`)).toBe(1);

    const claim2 = log("escrow", "PaymentClaimed", { paymentId: pid(1), runId: CHAIN_RUN, recipient: R2, amount: 50n * E18 }, nextTx(), 0);
    await applyLogs(db, [claim2]);
    r = (await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [run.id]))[0]!;
    expect(r.status).toBe("completed");
    expect(String(r.claimed_amount)).toBe((150n * E18).toString());
    const items = await loadItems(db, run.id);
    expect(items.every((i) => i.claim_status === "claimed" && i.transaction_hash)).toBe(true);
    // owner + approver(admin-only notification → owner only) for payment_claimed; run_completed to everyone once
    expect(await count(db, `SELECT count(*)::text AS n FROM notifications WHERE kind = 'run_completed'`)).toBe(2);
  });

  it("never moves a run backwards on a stale event", async () => {
    const stale = log("escrow", "RunFunded", { runId: CHAIN_RUN, funder: OWNER, amount: 150n * E18 }, nextTx(), 0);
    await applyLogs(db, [stale]);
    const r = (await db.query<RunRow>(`SELECT status FROM payroll_runs WHERE id = $1`, [run.id]))[0]!;
    expect(r.status).toBe("completed");
  });

  it("events for unknown runs are recorded but change nothing", async () => {
    const res = await applyLogs(db, [log("escrow", "RunFunded", { runId: 999n, funder: OWNER, amount: 1n }, nextTx(), 0)]);
    expect(res.applied).toBe(1);
    expect(res.touchedRuns.size).toBe(0);
  });

  it("refunds accumulate per distinct event only", async () => {
    const ev = log("escrow", "Refunded", { runId: CHAIN_RUN, to: OWNER, amount: 5n }, nextTx(), 0);
    await applyLogs(db, [ev, ev]);
    await applyLogs(db, [ev]);
    const r = (await db.query<{ refunded_amount: string }>(`SELECT refunded_amount FROM payroll_runs WHERE id = $1`, [run.id]))[0]!;
    expect(String(r.refunded_amount)).toBe("5");
  });

  it("concurrent application of the same logs applies each exactly once", async () => {
    const db2 = await freshDb();
    const logs = [log("escrow", "RunFunded", { runId: 1n, funder: OWNER, amount: 1n }, nextTx(), 0), log("escrow", "Refunded", { runId: 1n, to: OWNER, amount: 1n }, nextTx(), 0)];
    const [a, b] = await Promise.all([applyLogs(db2, logs), applyLogs(db2, logs)]);
    expect(a.applied + b.applied).toBe(2);
    expect(await count(db2, `SELECT count(*)::text AS n FROM indexed_events`)).toBe(2);
    await db2.close();
  });
});

describe("runIndexerPass", () => {
  it("chunks ≤5,000 blocks from the deploy block, respects confirmations and resumes from the cursor", async () => {
    const db = await freshDb();
    const calls: [bigint, bigint][] = [];
    let head = 12_102n;
    const evAt = (bn: bigint) => log("escrow", "Refunded", { runId: 42n, to: OWNER, amount: 1n }, nextTx(), 0, bn);
    const all = [evAt(150n), evAt(6_000n), evAt(12_100n), evAt(12_101n)];
    const source = {
      latestBlock: async () => head,
      fetchLogs: async (from: bigint, to: bigint) => {
        calls.push([from, to]);
        return all.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
      },
    };
    const r1 = await runIndexerPass(db, source, { deployBlock: 100n, confirmations: 2 });
    expect(calls.every(([f, t]) => t - f + 1n <= 5000n)).toBe(true);
    expect(calls[0]![0]).toBe(100n);
    expect(r1.toBlock).toBe("12100");
    expect(r1.applied).toBe(3);
    expect(r1.caughtUp).toBe(true);
    expect(await getCursor(db)).toBe(12_100n);

    head = 12_103n;
    calls.length = 0;
    const r2 = await runIndexerPass(db, source, { deployBlock: 100n, confirmations: 2 });
    expect(calls).toEqual([[12_101n, 12_101n]]);
    expect(r2.applied).toBe(1);

    // A second pass over an already indexed range applies nothing.
    await db.query(`UPDATE indexer_cursor SET last_block = 99`);
    const r3 = await runIndexerPass(db, source, { deployBlock: 100n, confirmations: 2, chunkSize: 5000n });
    expect(r3.applied).toBe(0);
    expect(r3.skipped).toBe(4);
    await db.close();
  });

  it("uses the escrow address from config", () => {
    expect(ESCROW).toMatch(/^0x1000/);
  });
});
