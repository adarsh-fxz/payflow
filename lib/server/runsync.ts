/**
 * Reconciles a DB run with live contract state (getRun + getPayments). The chain is the source of
 * truth; this sets absolute values, so it is idempotent and safe to run alongside the indexer.
 */
import "./guard";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { CHAIN_RUN_STATUS, MEZO_TESTNET_ID, contracts } from "../chain/config";
import { paymentsHash, type CommitmentOp } from "../chain/commitment";
import type { RunStatus } from "../api-types";
import type { Db } from "./db";
import type { ChainPayment, ChainRun } from "./chain";
import { deriveClaimStatus, insertUnreviewedItem, recomputeTotals } from "./indexer";
import { flagChainMismatch, hasMismatch, notifyPaymentsAvailable } from "./lifecycle";
import type { ItemRow, RunRow } from "./dto";

export const runRefOf = (runId: string): Hex => keccak256(toBytes(runId));

export function chainStatusToRunStatus(status: number): RunStatus | null {
  const s = CHAIN_RUN_STATUS[status];
  switch (s) {
    case "draft": return "onchain_draft";
    case "pending_approval": return "pending_approval";
    case "approved": return "approved";
    case "funded": return "funded";
    case "published": return "published";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    default: return null;
  }
}

const PAGE = 400;

/**
 * Writes chain state into the DB run + items. Pure DB work; the caller reads the chain.
 * Reviewed draft items are never rewritten: the chain's recipient/amount go to chain_* columns and
 * any difference is flagged (PayrollRun.chainMismatch). Notifications are left to the indexer
 * (event-driven, deduped) except payment_available, which is safe to send once the run is published.
 */
export async function applyChainState(db: Db, run: RunRow, chain: ChainRun, payments: ChainPayment[]): Promise<void> {
  const status = chainStatusToRunStatus(chain.status);
  if (!status) return;
  const chainRunId = BigInt(run.chain_run_id!);
  await db.transaction(async (tx) => {
    for (let from = 0; from < payments.length; from += PAGE) {
      const rows = payments.slice(from, from + PAGE).map((p, k) => {
        const i = from + k;
        let itemStatus = p.status === 2 ? "claimed" : p.status === 3 ? "cancelled" : "allocated";
        if (itemStatus === "allocated" && status === "expired") itemStatus = "expired";
        if (itemStatus === "allocated" && status === "cancelled") itemStatus = "cancelled";
        const claimedAt = p.claimedAt > 0n ? new Date(Number(p.claimedAt) * 1000) : null;
        return { i, pid: ((chainRunId << 32n) | BigInt(i)).toString(), recipient: p.recipient.toLowerCase(), amount: p.amount.toString(), itemStatus, claimedAt };
      });
      const params: unknown[] = [run.id];
      const values = rows.map((r) => {
        params.push(r.i, r.pid, r.recipient, r.amount, r.itemStatus, r.claimedAt);
        const b = params.length - 6;
        return `($${b + 1}::int, $${b + 2}::numeric, $${b + 3}::text, $${b + 4}::numeric, $${b + 5}::text, $${b + 6}::timestamptz)`;
      });
      const updated = await tx.query<{ item_index: number }>(
        `UPDATE payroll_items i SET payment_id = v.pid, chain_recipient_address = v.recipient, chain_amount = v.amount, claim_status = v.st,
           claimed_at = COALESCE(i.claimed_at, v.claimed_at),
           recipient_address = CASE WHEN i.reviewed THEN i.recipient_address ELSE v.recipient END,
           amount = CASE WHEN i.reviewed THEN i.amount ELSE v.amount END
         FROM (VALUES ${values.join(", ")}) AS v(idx, pid, recipient, amount, st, claimed_at)
         WHERE i.payroll_run_id = $1 AND i.item_index = v.idx
         RETURNING i.item_index`,
        params,
      );
      const seen = new Set(updated.map((u) => Number(u.item_index)));
      for (const r of rows) {
        if (!seen.has(r.i)) await insertUnreviewedItem(tx, run.id, r.i, r.recipient, r.amount, r.pid, r.itemStatus, null, r.claimedAt);
      }
    }
    if (status === "cancelled") {
      await tx.query(`UPDATE payroll_items SET claim_status = 'cancelled' WHERE payroll_run_id = $1 AND claim_status = 'pending'`, [run.id]);
    }
    await tx.query(
      `UPDATE payroll_runs SET status = $2, funded_amount = $3, claimed_amount = $4, refunded_amount = $5, claimed_count = $6,
         claim_deadline = $7, funder_wallet = $8, approvals_required = $9, chain_claim_window_seconds = $10, updated_at = now()
       WHERE id = $1`,
      [
        run.id, status, chain.funded.toString(), chain.claimed.toString(), chain.refunded.toString(), chain.claimedCount,
        chain.claimDeadline > 0n ? new Date(Number(chain.claimDeadline) * 1000) : null,
        /^0x0{40}$/.test(chain.funder) ? null : chain.funder,
        chain.approvalsRequired,
        Number(chain.claimWindow),
      ],
    );
    await recomputeTotals(tx, run.id);
    if (status === "published") await deriveClaimStatus(tx, run.id);
  });
  if (await hasMismatch(db, run.id)) await flagChainMismatch(db, run, null);
  if (status === "published") await notifyPaymentsAvailable(db, run.id);
}

type Pos = readonly [bigint, number, number, number]; // block, logIndex, sub-order, item index
const INF = 1n << 255n;
const cmpPos = (a: Pos, b: Pos) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? a[1] - b[1] : a[2] !== b[2] ? a[2] - b[2] : a[3] - b[3]);

/**
 * Ops for the rolling commitment, built ONLY from reviewed items (recipient + amount as reviewed),
 * in on-chain event order (block, logIndex) taken from indexed PaymentAllocated/PaymentCancelled
 * events. A payment whose event is not indexed yet is placed just before the first known later op
 * on the same or a higher index (allocation is strictly sequential), else after every known op.
 * If the chain allocated anything else, the result deliberately differs from the on-chain hash.
 */
export async function commitmentOps(db: Db, run: RunRow, items: ItemRow[]): Promise<CommitmentOp[]> {
  const reviewed = items.filter((i) => i.reviewed !== false).sort((a, b) => a.item_index - b.item_index);
  const addAt = new Map<number, Pos>();
  const cancelAt = new Map<number, Pos>();
  if (run.chain_run_id != null) {
    const ev = await db.query<{ event_name: string; block_number: string; log_index: number; payment_id: string }>(
      `SELECT event_name, block_number::text AS block_number, log_index, args_json->>'paymentId' AS payment_id FROM indexed_events
       WHERE contract_address = $1 AND event_name IN ('PaymentAllocated', 'PaymentCancelled') AND args_json->>'runId' = $2`,
      [contracts.escrow.toLowerCase(), String(run.chain_run_id)],
    );
    for (const e of ev) {
      const index = Number(BigInt(e.payment_id) & 0xffffffffn);
      const pos: Pos = [BigInt(e.block_number), Number(e.log_index), 0, index];
      (e.event_name === "PaymentAllocated" ? addAt : cancelAt).set(index, pos);
    }
  }
  /** Earliest known op that must come after the add of `index`: a later add, or a cancel of this or a later index. */
  const knownAfter = (index: number): Pos | null => {
    let best: Pos | null = null;
    for (const [i, p] of addAt) if (i > index && (!best || cmpPos(p, best) < 0)) best = p;
    for (const [i, p] of cancelAt) if (i >= index && (!best || cmpPos(p, best) < 0)) best = p;
    return best;
  };
  const keyed: { pos: Pos; op: CommitmentOp }[] = [];
  for (const it of reviewed) {
    const index = Number(it.item_index);
    const known = addAt.get(index);
    const after = known ? null : knownAfter(index);
    const pos: Pos = known ?? (after ? [after[0], after[1], -1, index] : [INF, 0, 0, index]);
    keyed.push({ pos, op: { kind: "add", index, recipient: it.recipient_address as Address, amount: BigInt(String(it.amount)) } });
    // Payment-level cancels exist only in draft; a whole-run cancel marks items cancelled without one.
    const cancelled = it.claim_status === "cancelled" && it.payment_id != null && (cancelAt.has(index) || run.status !== "cancelled");
    if (cancelled) keyed.push({ pos: cancelAt.get(index) ?? [INF, 1, 0, index], op: { kind: "cancel", index } });
  }
  return keyed.sort((a, b) => cmpPos(a.pos, b.pos)).map((k) => k.op);
}

export async function expectedPaymentsHash(db: Db, run: RunRow, items: ItemRow[]): Promise<Hex | null> {
  if (run.chain_run_id == null) return null;
  // The reviewed claim window, never the on-chain one: a different window must not match.
  return paymentsHash(MEZO_TESTNET_ID, contracts.escrow, BigInt(run.chain_run_id), Number(run.claim_window_days) * 86400, await commitmentOps(db, run, items));
}
