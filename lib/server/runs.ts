/**
 * Payroll runs: off-chain draft CRUD, chain plan, tx verification and chain sync.
 * The client never tells us amounts or status: every on-chain step is verified from the receipt
 * and then reconciled against live contract state.
 */
import "./guard";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Hex, PayrollRun, PayrollRunDetail, RunChainPlan, RunStatus, RunTxAction } from "../api-types";
import { ESCROW_LIMITS, MEZO_TESTNET_ID, contracts, isDeployed, splitPaymentId } from "../chain/config";
import { toCsv } from "../csv/validate";
import { itemStatus } from "@/lib/client/status";
import type { ItemClaimStatus, RunStatus as ApiRunStatus } from "@/lib/api-types";
import { weiToDecimalString } from "../money";
import type { Db } from "./db";
import { fail, parseUuid, runBlocked } from "./http";
import { hasRoleMask, MASK, type OrgAccess, type OrgRow } from "./authz";
import { runDetailDto, runDto, type ApprovalRow, type ItemRow, type RunExtras, type RunRow } from "./dto";
import { audit } from "./audit";
import { assertSuccessfulCall, fetchReceipt, readPayments, readRun, readRunIdByRef, readValidApprovals, requireDeployed, type ChainLog, type VerifiedReceipt } from "./chain";
import { loadMismatches, runMismatches } from "./lifecycle";
import { mapLimit } from "./concurrency";
import { applyLogs } from "./indexer";
import { applyChainState, expectedPaymentsHash, runRefOf } from "./runsync";
import type { createRunSchema, runItemSchema, runTxSchema, updateRunSchema } from "./schemas";

type ItemInput = z.infer<typeof runItemSchema>;

export async function loadRun(db: Db, orgId: string, runId: string): Promise<RunRow> {
  const rows = await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1 AND organization_id = $2`, [parseUuid(runId, "Run"), orgId]);
  if (!rows[0]) throw fail("not_found", "Payroll run not found");
  return rows[0];
}

async function reloadRun(db: Db, id: string): Promise<RunRow> {
  const rows = await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [id]);
  return rows[0]!;
}

export async function loadItems(db: Db, runId: string): Promise<ItemRow[]> {
  return db.query<ItemRow>(`SELECT * FROM payroll_items WHERE payroll_run_id = $1 ORDER BY item_index`, [runId]);
}

async function loadApprovals(db: Db, runId: string): Promise<ApprovalRow[]> {
  return db.query<ApprovalRow>(`SELECT approver_wallet, status, approved_at, rejection_reason, tx_hash FROM payment_approvals WHERE payroll_run_id = $1 ORDER BY approved_at`, [runId]);
}

/** Statuses after submitForApproval in which approvals are meaningful on-chain. */
const APPROVAL_STATUSES: readonly string[] = ["pending_approval", "approved", "funded", "published", "partially_claimed", "completed", "cancelled", "expired"];
const LIVE_APPROVAL_LIST_STATUSES: readonly string[] = ["pending_approval", "approved", "funded"];
const LIVE_READ_BUDGET_MS = 3_000;

function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then((v) => resolve(v), () => resolve(null)).finally(() => clearTimeout(t));
  });
}

/** Live PayrollEscrow.validApprovals + approvalsRequired; null before submit or when the RPC is unreachable/slow. */
export async function liveApprovals(run: RunRow, budgetMs = LIVE_READ_BUDGET_MS): Promise<Pick<RunExtras, "validApprovals" | "approvalsRequired">> {
  const none = { validApprovals: null, approvalsRequired: null };
  if (!isDeployed || run.chain_run_id == null || !APPROVAL_STATUSES.includes(run.status) || budgetMs <= 0) return none;
  const id = BigInt(run.chain_run_id);
  const r = await withinBudget(Promise.all([readValidApprovals(id), readRun(id)]), budgetMs);
  return r ? { validApprovals: r[0], approvalsRequired: r[1].approvalsRequired } : none;
}


export async function runDetail(db: Db, run: RunRow): Promise<PayrollRunDetail> {
  const [approvals, items, chainMismatch, live] = await Promise.all([loadApprovals(db, run.id), loadItems(db, run.id), runMismatches(db, run.id), liveApprovals(run)]);
  return runDetailDto(run, approvals, items, { ...live, chainMismatch });
}

export async function listRuns(db: Db, orgId: string, status?: string): Promise<PayrollRun[]> {
  const rows = await db.query<RunRow>(
    `SELECT * FROM payroll_runs WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 500`,
    [orgId, status ?? null],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const approvals = await db.query<ApprovalRow & { payroll_run_id: string }>(
    `SELECT payroll_run_id, approver_wallet, status, approved_at, rejection_reason, tx_hash FROM payment_approvals
     WHERE payroll_run_id = ANY($1::uuid[]) ORDER BY approved_at`,
    [`{${ids.join(",")}}`],
  );
  const mismatches = await loadMismatches(db, ids, 20);
  // Live approval counts only where they decide the next step; bounded concurrency + per-call budget.
  const liveTargets = rows.filter((r) => LIVE_APPROVAL_LIST_STATUSES.includes(r.status)).slice(0, 50);
  // One shared 3 s budget for the whole list, so a slow RPC never multiplies the wait.
  const deadline = Date.now() + LIVE_READ_BUDGET_MS;
  const live = new Map((await mapLimit(liveTargets, 6, async (r) => [r.id, await liveApprovals(r, deadline - Date.now())] as const)).map(([k, v]) => [k, v]));
  const byRun = new Map<string, ApprovalRow[]>();
  for (const a of approvals) byRun.set(a.payroll_run_id, [...(byRun.get(a.payroll_run_id) ?? []), a]);
  return rows.map((r) =>
    runDto(r, byRun.get(r.id) ?? [], { validApprovals: null, approvalsRequired: null, ...live.get(r.id), chainMismatch: mismatches.get(r.id) ?? [] }),
  );
}

/** Validates items against the org: no duplicate wallets; recipientIds must be the org's active recipients. */
async function checkItems(db: Db, orgId: string, items: ItemInput[]): Promise<void> {
  if (items.length > ESCROW_LIMITS.MAX_PAYMENTS_PER_RUN) throw fail("invalid_input", `A run can have at most ${ESCROW_LIMITS.MAX_PAYMENTS_PER_RUN} payments`);
  const seen = new Map<string, number>();
  const dups: { row: number; firstRow: number; wallet: string }[] = [];
  items.forEach((it, i) => {
    const first = seen.get(it.walletAddress);
    if (first !== undefined) dups.push({ row: i + 1, firstRow: first + 1, wallet: it.walletAddress });
    else seen.set(it.walletAddress, i);
  });
  if (dups.length) throw fail("invalid_input", `Duplicate wallet in ${dups.length} item(s)`, { duplicates: dups });
  const ids = [...new Set(items.map((i) => i.recipientId).filter((v): v is string => !!v))];
  if (ids.length) {
    const found = await db.query<{ id: string; status: string; wallet_address: string }>(
      `SELECT id, status, wallet_address FROM recipients WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, `{${ids.join(",")}}`],
    );
    const byId = new Map(found.map((f) => [f.id, f]));
    const bad = ids.filter((id) => !byId.has(id));
    if (bad.length) throw fail("invalid_input", "Some recipientIds do not belong to this organization", { recipientIds: bad });
    const inactive = ids.filter((id) => byId.get(id)!.status !== "active");
    if (inactive.length) throw fail("invalid_input", "Some recipients are inactive", { recipientIds: inactive });
  }
}

const INSERT_CHUNK = 1000; // 10 params per row → 10,000 params per statement (Postgres limit 65,535)

/** Multi-row inserts: 5,000 items are a handful of statements, not 5,000 round trips. */
async function insertItems(db: Db, runId: string, items: ItemInput[]): Promise<void> {
  for (let from = 0; from < items.length; from += INSERT_CHUNK) {
    const chunk = items.slice(from, from + INSERT_CHUNK);
    const params: unknown[] = [];
    const values = chunk.map((it, k) => {
      params.push(crypto.randomUUID(), runId, it.recipientId, from + k, it.name, it.email, it.department, it.walletAddress, it.amount, it.description);
      const b = params.length - 10;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, 'pending')`;
    });
    await db.query(
      `INSERT INTO payroll_items (id, payroll_run_id, recipient_id, item_index, name, email, department, recipient_address, amount, description, claim_status)
       VALUES ${values.join(", ")}`,
      params,
    );
  }
  await db.query(
    `UPDATE payroll_runs SET total_amount = COALESCE((SELECT sum(amount) FROM payroll_items WHERE payroll_run_id = $1), 0),
       recipient_count = (SELECT count(*) FROM payroll_items WHERE payroll_run_id = $1), updated_at = now() WHERE id = $1`,
    [runId],
  );
}

export async function createRun(
  db: Db,
  actor: string,
  org: OrgRow,
  input: z.infer<typeof createRunSchema>,
  extra: { scheduleId?: string | null } = {},
): Promise<PayrollRunDetail> {
  await checkItems(db, org.id, input.items);
  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO payroll_runs (id, organization_id, run_ref, name, payment_category, frequency, schedule_id, token_address, scheduled_at, claim_window_days, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11)`,
      [id, org.id, runRefOf(id), input.name, input.paymentCategory, input.frequency, extra.scheduleId ?? null, contracts.musd.toLowerCase(), input.scheduledAt, input.claimWindowDays ?? Number(org.default_claim_window_days), actor],
    );
    await insertItems(tx, id, input.items);
    await audit(tx, { orgId: org.id, actor, action: "run.create", resourceId: id, metadata: { name: input.name, items: input.items.length, scheduleId: extra.scheduleId ?? null } });
  });
  return runDetail(db, await reloadRun(db, id));
}

function assertOffchainDraft(run: RunRow): void {
  if (run.status !== "draft" || run.chain_run_id != null) throw fail("conflict", "Only off-chain drafts can be edited or deleted");
}

export async function updateRun(db: Db, actor: string, org: OrgRow, run: RunRow, input: z.infer<typeof updateRunSchema>): Promise<PayrollRunDetail> {
  assertOffchainDraft(run);
  if (input.items) await checkItems(db, org.id, input.items);
  await db.transaction(async (tx) => {
    const locked = await tx.query(`SELECT id FROM payroll_runs WHERE id = $1 AND status = 'draft' AND chain_run_id IS NULL FOR UPDATE`, [run.id]);
    if (!locked.length) throw fail("conflict", "Run is no longer an off-chain draft");
    await tx.query(
      `UPDATE payroll_runs SET name = $2, payment_category = $3, frequency = $4, scheduled_at = $5, claim_window_days = $6, updated_at = now() WHERE id = $1`,
      [
        run.id,
        input.name ?? run.name,
        input.paymentCategory ?? run.payment_category,
        input.frequency ?? run.frequency,
        input.scheduledAt !== undefined ? input.scheduledAt : run.scheduled_at,
        input.claimWindowDays ?? run.claim_window_days,
      ],
    );
    if (input.items) {
      await tx.query(`DELETE FROM payroll_items WHERE payroll_run_id = $1`, [run.id]);
      await insertItems(tx, run.id, input.items);
    }
    await audit(tx, { orgId: org.id, actor, action: "run.update", resourceId: run.id, metadata: { fields: Object.keys(input), items: input.items?.length ?? null } });
  });
  return runDetail(db, await reloadRun(db, run.id));
}

export async function deleteRun(db: Db, actor: string, org: OrgRow, run: RunRow): Promise<void> {
  assertOffchainDraft(run);
  const del = await db.query(`DELETE FROM payroll_runs WHERE id = $1 AND status = 'draft' AND chain_run_id IS NULL RETURNING id`, [run.id]);
  if (!del.length) throw fail("conflict", "Run is no longer an off-chain draft");
  await audit(db, { orgId: org.id, actor, action: "run.delete", resourceId: run.id, metadata: { name: run.name } });
}

// ---------------------------------------------------------------------------------------------
// Chain plan
// ---------------------------------------------------------------------------------------------

export function buildBatches(items: Pick<ItemRow, "item_index" | "recipient_address" | "amount" | "payment_id" | "claim_status">[], maxBatch: number = ESCROW_LIMITS.MAX_BATCH) {
  const sorted = [...items].sort((a, b) => a.item_index - b.item_index);
  const allocatedCount = sorted.filter((i) => i.payment_id != null).length;
  const pending = sorted.filter((i) => i.payment_id == null && i.claim_status === "pending");
  // Allocation is strictly sequential: the first pending index must equal the on-chain paymentCount.
  pending.forEach((p, k) => {
    if (p.item_index !== allocatedCount + k) throw fail("conflict", "Run items are out of order with on-chain allocations; sync the run");
  });
  const batches: RunChainPlan["batches"] = [];
  for (let i = 0; i < pending.length; i += maxBatch) {
    const chunk = pending.slice(i, i + maxBatch);
    batches.push({
      expectedIndex: chunk[0]!.item_index,
      recipients: chunk.map((c) => c.recipient_address as Hex),
      amounts: chunk.map((c) => BigInt(String(c.amount)).toString()),
    });
  }
  return batches;
}

export async function runPlan(db: Db, run: RunRow): Promise<RunChainPlan> {
  requireDeployed();
  // Never hand out batches or an approval hash for a run whose on-chain payments differ from the review.
  const mismatch = await runMismatches(db, run.id);
  if (mismatch.length) throw runBlocked(mismatch);
  const items = await loadItems(db, run.id);
  const canAllocate = run.status === "draft" || run.status === "onchain_draft";
  const allocatedWei = items.filter((i) => i.payment_id != null && i.claim_status !== "cancelled").reduce((a, i) => a + BigInt(String(i.amount)), 0n);
  return {
    runRef: run.run_ref as Hex,
    chainRunId: run.chain_run_id == null ? null : String(run.chain_run_id),
    claimWindowSeconds: Number(run.claim_window_days) * 86400,
    batches: canAllocate ? buildBatches(items) : [],
    expectedPaymentsHash: await expectedPaymentsHash(db, run, items),
    allocatedWei: allocatedWei.toString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Tx verification
// ---------------------------------------------------------------------------------------------

/** Role mask the contract enforces for each action (cancel paths depend on run status). null = permissionless. */
export function actionMask(action: RunTxAction, status: RunStatus): number | null {
  switch (action) {
    case "create":
    case "allocate":
    case "submit":
    case "cancel_payment": // draft only on-chain
      return MASK.OPERATOR_OR_ADMIN;
    case "return":
      return status === "approved" ? MASK.ADMIN : MASK.RETURN_TO_DRAFT;
    case "approve":
      return MASK.APPROVER;
    case "cancel":
      return status === "funded" || status === "approved" ? MASK.ADMIN : MASK.OPERATOR_OR_ADMIN;
    case "fund":
    case "publish":
      return MASK.ADMIN;
    case "expire":
      return null; // PayrollEscrow.expireRun is permissionless once the claim window has closed
    case "refund":
      return null; // PayrollEscrow.refund is permissionless and always pays run.funder
  }
}

const EXPECTED_EVENT: Record<RunTxAction, string> = {
  create: "RunCreated",
  allocate: "PaymentAllocated",
  submit: "RunSubmitted",
  approve: "RunApproved",
  return: "RunReturnedToDraft",
  fund: "RunFunded",
  publish: "RunPublished",
  cancel: "RunCancelled",
  cancel_payment: "PaymentCancelled",
  expire: "RunExpired",
  refund: "Refunded",
};

/**
 * Checks the receipt's events against the DB for this run. Pure (no chain/DB IO) so it is unit-testable.
 * Throws chain_mismatch on any discrepancy.
 */
export function verifyRunEvents(
  action: RunTxAction,
  run: Pick<RunRow, "chain_run_id" | "run_ref" | "claim_window_days">,
  orgChainId: string,
  items: Pick<ItemRow, "item_index" | "recipient_address" | "amount">[],
  logs: ChainLog[],
): ChainLog[] {
  const escrow = contracts.escrow.toLowerCase();
  const name = EXPECTED_EVENT[action];
  const evs = logs.filter((l) => l.address === escrow && l.eventName === name);
  if (action === "create") {
    const ev = evs.find((l) => String(l.args.runRef).toLowerCase() === run.run_ref.toLowerCase());
    if (!ev) throw fail("chain_mismatch", "Transaction did not create this run (runRef mismatch)");
    if (String(ev.args.orgId) !== orgChainId) throw fail("chain_mismatch", "Run was created for a different organization");
    if (run.chain_run_id != null && String(run.chain_run_id) !== String(ev.args.runId)) throw fail("chain_mismatch", "Run is already linked to a different on-chain run");
    if (Number(ev.args.claimWindow) !== Number(run.claim_window_days) * 86400) {
      throw fail("chain_mismatch", "On-chain claim window differs from the run's claim window", { expected: Number(run.claim_window_days) * 86400, actual: Number(ev.args.claimWindow) });
    }
    return [ev];
  }
  if (run.chain_run_id == null) throw fail("conflict", "Run is not on-chain yet; report the create transaction first");
  const mine = evs.filter((l) => String(l.args.runId) === String(run.chain_run_id));
  if (mine.length === 0) throw fail("chain_mismatch", `Transaction has no ${name} event for this run`);
  if (action === "allocate") {
    const byIndex = new Map(items.map((i) => [Number(i.item_index), i]));
    const indices: number[] = [];
    for (const ev of mine) {
      const { runId, index } = splitPaymentId(BigInt(String(ev.args.paymentId)));
      if (runId.toString() !== String(run.chain_run_id)) throw fail("chain_mismatch", "Payment id belongs to another run");
      const it = byIndex.get(index);
      if (!it) throw fail("chain_mismatch", `On-chain payment #${index} has no matching item`);
      if (String(ev.args.recipient).toLowerCase() !== it.recipient_address.toLowerCase()) {
        throw fail("chain_mismatch", `Payment #${index}: recipient differs from the run item`, { index, expected: it.recipient_address, actual: String(ev.args.recipient).toLowerCase() });
      }
      if (String(ev.args.amount) !== BigInt(String(it.amount)).toString()) {
        throw fail("chain_mismatch", `Payment #${index}: amount differs from the run item`, { index, expected: String(it.amount), actual: String(ev.args.amount) });
      }
      indices.push(index);
    }
    indices.forEach((v, k) => {
      if (k > 0 && v !== indices[k - 1]! + 1) throw fail("chain_mismatch", "Allocated payments are not in item order");
    });
  }
  return mine;
}

async function syncFromChain(db: Db, run: RunRow): Promise<RunRow> {
  if (run.chain_run_id == null) return run;
  const chain = await readRun(BigInt(run.chain_run_id));
  const payments = await readPayments(BigInt(run.chain_run_id), chain.paymentCount);
  await applyChainState(db, run, chain, payments);
  return reloadRun(db, run.id);
}

async function upsertManifest(db: Db, run: RunRow, items: ItemRow[], hash: Hex): Promise<void> {
  const m = buildManifest(run, items, hash);
  const exists = await db.query(`SELECT id FROM payment_manifests WHERE payroll_run_id = $1 AND manifest_hash = $2`, [run.id, m.manifestHash]);
  if (exists.length) return;
  await db.query(
    `INSERT INTO payment_manifests (id, payroll_run_id, manifest_hash, payments_hash, total_amount, recipient_count, manifest_json) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [crypto.randomUUID(), run.id, m.manifestHash, hash, m.totalAmount, m.recipientCount, JSON.stringify(m.payments)],
  );
}

/** Verifies the commitment once every item is allocated; stores it; throws chain_mismatch if it differs. */
async function checkCommitment(db: Db, run: RunRow, chainHash: Hex | null): Promise<void> {
  const items = await loadItems(db, run.id);
  const fullyAllocated = items.length > 0 && items.every((i) => i.payment_id != null);
  if (!fullyAllocated || run.chain_run_id == null) return;
  const expected = await expectedPaymentsHash(db, run, items);
  if (!expected) return;
  await db.query(`UPDATE payroll_runs SET payments_hash = $2 WHERE id = $1`, [run.id, expected]);
  if (chainHash && chainHash.toLowerCase() !== expected.toLowerCase()) {
    await audit(db, { orgId: run.organization_id, actor: "system", action: "run.payments_hash_mismatch", resourceId: run.id, metadata: { expected, actual: chainHash } });
    throw fail("chain_mismatch", "On-chain payments commitment does not match the reviewed run. Return it to draft and fix the payments", { expected, actual: chainHash }, 409);
  }
  await upsertManifest(db, run, items, expected);
}

/** Reports that are refused (409 chain_mismatch) while the run's on-chain payments differ from the review. */
const BLOCKED_ACTIONS: readonly RunTxAction[] = ["allocate", "submit", "approve", "fund", "publish"];
/** Short wait for the receipt: the wallet already waited for it, but RPC nodes can lag a block. */
const RECEIPT_WAIT_MS = 5_000;

export async function applyRunTx(db: Db, actor: string, access: OrgAccess, run: RunRow, req: z.infer<typeof runTxSchema>): Promise<PayrollRunDetail> {
  requireDeployed();
  const org = access.org;
  if (org.chain_org_id == null) throw fail("conflict", "Organization is not confirmed on-chain yet");
  const mask = actionMask(req.action, run.status as RunStatus);
  if (mask !== null && !hasRoleMask(access.roles, mask, access.isOwner)) {
    throw fail("forbidden", "Your role does not allow this action");
  }
  if (req.action === "create" && run.status !== "draft" && run.chain_run_id == null) throw fail("conflict", "Run is not a draft");
  if (req.action === "cancel_payment" && run.status !== "onchain_draft") {
    throw fail("conflict", "Payments can only be cancelled while the run is an on-chain draft. Cancel the whole run instead");
  }

  const receipt: VerifiedReceipt = await fetchReceipt(req.txHash, { waitMs: RECEIPT_WAIT_MS });
  assertSuccessfulCall(receipt, contracts.escrow);
  if (req.action === "create") {
    // Link check before anything is written: the tx must have created THIS run for THIS org.
    const items0 = await loadItems(db, run.id);
    const ev = verifyRunEvents("create", run, String(org.chain_org_id), items0, receipt.logs)[0]!;
    if (run.chain_run_id == null) {
      const clash = await db.query(`SELECT id FROM payroll_runs WHERE chain_run_id = $1 AND id <> $2`, [String(ev.args.runId), run.id]);
      if (clash.length) throw fail("conflict", "That on-chain run is already linked to another run");
    }
  }

  // Apply every escrow/registry event in the receipt first (dedupe makes replays a no-op). The
  // indexer handlers never overwrite reviewed items, and record + alert on any mismatch.
  await applyLogs(db, receipt.logs);
  if (req.action === "return" && req.rejectionReason) {
    await db.query(`UPDATE payment_approvals SET rejection_reason = $3 WHERE payroll_run_id = $1 AND tx_hash = $2 AND status = 'rejected'`, [run.id, receipt.hash, req.rejectionReason]);
  }
  let fresh = await reloadRun(db, run.id);
  fresh = await syncFromChain(db, fresh);

  const mismatch = await runMismatches(db, run.id);
  await audit(db, {
    orgId: org.id, actor, action: `run.tx.${req.action}`, resourceId: run.id,
    metadata: { txHash: receipt.hash, block: receipt.blockNumber.toString(), status: fresh.status, chainMismatch: mismatch.length },
  });
  if (mismatch.length && BLOCKED_ACTIONS.includes(req.action)) throw runBlocked(mismatch);

  const items = await loadItems(db, run.id);
  verifyRunEvents(req.action, fresh, String(org.chain_org_id), items, receipt.logs);

  if (req.action === "allocate" || req.action === "approve" || req.action === "submit") {
    const chain = fresh.chain_run_id != null ? await readRun(BigInt(fresh.chain_run_id)) : null;
    await checkCommitment(db, fresh, chain?.paymentsHash ?? null);
    fresh = await reloadRun(db, run.id);
  }
  return runDetail(db, fresh);
}

/** POST /sync: re-read run + payments from chain. Recovers chainRunId via runIdByRef if the create tx was never reported. */
export async function syncRun(db: Db, actor: string, org: OrgRow, run: RunRow): Promise<PayrollRunDetail> {
  requireDeployed();
  let cur = run;
  if (cur.chain_run_id == null && org.chain_org_id != null) {
    const id = await readRunIdByRef(BigInt(org.chain_org_id), cur.run_ref as Hex);
    if (id > 0n) {
      await db.query(`UPDATE payroll_runs SET chain_run_id = $2, updated_at = now() WHERE id = $1 AND chain_run_id IS NULL`, [cur.id, id.toString()]);
      cur = await reloadRun(db, cur.id);
    }
  }
  cur = await syncFromChain(db, cur);
  await audit(db, { orgId: org.id, actor, action: "run.sync", resourceId: run.id, metadata: { status: cur.status } });
  return runDetail(db, cur);
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

export interface RunManifest {
  version: 1;
  chainId: number;
  escrow: Hex;
  token: Hex;
  runId: string;
  chainRunId: string | null;
  runRef: Hex;
  paymentsHash: Hex | null;
  manifestHash: string;
  totalAmount: string;
  recipientCount: number;
  /** No names or emails: only what is on-chain anyway. */
  payments: { index: number; paymentId: string | null; recipient: Hex; amount: string; status: string }[];
}

export function buildManifest(run: RunRow, items: ItemRow[], paymentsHash: Hex | null): RunManifest {
  const payments = [...items]
    .sort((a, b) => a.item_index - b.item_index)
    .map((i) => ({ index: Number(i.item_index), paymentId: i.payment_id == null ? null : String(i.payment_id), recipient: i.recipient_address as Hex, amount: BigInt(String(i.amount)).toString(), status: i.claim_status }));
  const live = payments.filter((p) => p.status !== "cancelled");
  const body = {
    version: 1 as const,
    chainId: MEZO_TESTNET_ID,
    escrow: contracts.escrow.toLowerCase() as Hex,
    token: (run.token_address || contracts.musd).toLowerCase() as Hex,
    runId: run.id,
    chainRunId: run.chain_run_id == null ? null : String(run.chain_run_id),
    runRef: run.run_ref as Hex,
    paymentsHash,
    totalAmount: live.reduce((a, p) => a + BigInt(p.amount), 0n).toString(),
    recipientCount: live.length,
    payments: payments.map((p) => ({ index: p.index, paymentId: p.paymentId, recipient: p.recipient, amount: p.amount, status: p.status })),
  };
  const manifestHash = "0x" + createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, manifestHash };
}

export async function runManifest(db: Db, run: RunRow): Promise<RunManifest> {
  const items = await loadItems(db, run.id);
  const hash = await expectedPaymentsHash(db, run, items);
  return buildManifest(run, items, hash);
}

export async function runExportCsv(db: Db, run: RunRow): Promise<string> {
  const items = await loadItems(db, run.id);
  return toCsv(
    items.map((i) => ({
      index: i.item_index,
      name: i.name,
      email: i.email,
      department: i.department,
      wallet_address: i.recipient_address,
      amount: weiToDecimalString(String(i.amount)),
      amount_wei: BigInt(String(i.amount)).toString(),
      description: i.description,
      payment_id: i.payment_id == null ? "" : String(i.payment_id),
      // Same words as the UI ("Waiting for funding", "Unclaimed", …); the raw code stays for tooling.
      status: itemStatus(i.claim_status as ItemClaimStatus, run.status as ApiRunStatus).label,
      status_code: i.claim_status,
      claim_tx: i.transaction_hash,
      claimed_at: i.claimed_at,
    })),
    ["index", "name", "email", "department", "wallet_address", "amount", "amount_wei", "description", "payment_id", "status", "status_code", "claim_tx", "claimed_at"],
  );
}

