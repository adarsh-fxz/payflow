/**
 * Run lifecycle side effects shared by the indexer (event insertion), the per-tx /tx path and the
 * chain sync (runsync). Every notification here is deduped by key, so any of those paths may call
 * them in any order and each notice still goes out exactly once.
 */
import "./guard";
import type { ChainMismatch, Hex } from "../api-types";
import { weiToDecimalString } from "../money";
import type { Db } from "./db";
import { notify, notifyEmployer } from "./notifications";
import { links } from "./links";
import { audit } from "./audit";

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const big = (v: unknown) => BigInt(String(v ?? "0").split(".")[0] || "0");

/** SQL predicate (alias i) for an item whose on-chain allocation differs from the reviewed draft. */
export const MISMATCH_SQL = `(NOT i.reviewed OR (i.chain_recipient_address IS NOT NULL AND (i.chain_recipient_address <> i.recipient_address OR i.chain_amount <> i.amount)))`;

/** SQL predicate (alias r) for a run whose on-chain claim window differs from the reviewed one. */
export const WINDOW_MISMATCH_SQL = `(r.chain_claim_window_seconds IS NOT NULL AND r.chain_claim_window_seconds <> r.claim_window_days * 86400)`;

interface MismatchRow {
  payroll_run_id: string;
  item_index: number;
  name: string;
  reviewed: boolean;
  recipient_address: string;
  amount: string;
  chain_recipient_address: string | null;
  chain_amount: string | null;
  allocate_tx_hash: string | null;
}

function toMismatch(r: MismatchRow): ChainMismatch {
  return {
    index: Number(r.item_index),
    name: r.name,
    reviewedRecipient: r.reviewed ? (r.recipient_address as Hex) : ZERO,
    reviewedAmount: r.reviewed ? big(r.amount).toString() : "0",
    chainRecipient: (r.chain_recipient_address ?? r.recipient_address) as Hex,
    chainAmount: big(r.chain_amount ?? r.amount).toString(),
    txHash: (r.allocate_tx_hash as Hex | null) ?? null,
  };
}

/** Mismatches for many runs at once (bounded per run). */
export async function loadMismatches(db: Db, runIds: string[], perRunLimit = 200): Promise<Map<string, ChainMismatch[]>> {
  const out = new Map<string, ChainMismatch[]>();
  if (runIds.length === 0) return out;
  const rows = await db.query<MismatchRow>(
    `SELECT payroll_run_id, item_index, name, reviewed, recipient_address, amount::text AS amount, chain_recipient_address,
            chain_amount::text AS chain_amount, allocate_tx_hash
     FROM (SELECT i.*, row_number() OVER (PARTITION BY i.payroll_run_id ORDER BY i.item_index) AS rn
           FROM payroll_items i WHERE i.payroll_run_id = ANY($1::uuid[]) AND ${MISMATCH_SQL}) x
     WHERE rn <= $2 ORDER BY payroll_run_id, item_index`,
    [`{${runIds.join(",")}}`, perRunLimit],
  );
  const windows = await db.query<{ id: string; claim_window_days: number; chain_claim_window_seconds: number; create_tx_hash: string | null }>(
    `SELECT r.id, r.claim_window_days, r.chain_claim_window_seconds, r.create_tx_hash FROM payroll_runs r WHERE r.id = ANY($1::uuid[]) AND ${WINDOW_MISMATCH_SQL}`,
    [`{${runIds.join(",")}}`],
  );
  for (const w of windows) {
    out.set(w.id, [
      {
        kind: "claim_window",
        index: -1,
        name: "Claim window",
        reviewedClaimWindowSeconds: Number(w.claim_window_days) * 86400,
        chainClaimWindowSeconds: Number(w.chain_claim_window_seconds),
        reviewedRecipient: ZERO,
        reviewedAmount: "0",
        chainRecipient: ZERO,
        chainAmount: "0",
        txHash: (w.create_tx_hash as Hex | null) ?? null,
      },
    ]);
  }
  for (const r of rows) {
    const list = out.get(r.payroll_run_id) ?? [];
    list.push(toMismatch(r));
    out.set(r.payroll_run_id, list);
  }
  return out;
}

/** Cheap existence check used to hold back "needs approval" for a run that is already blocked. */
export async function hasMismatch(db: Db, runId: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM payroll_items i WHERE i.payroll_run_id = $1 AND ${MISMATCH_SQL}
     UNION ALL SELECT 1 FROM payroll_runs r WHERE r.id = $1 AND ${WINDOW_MISMATCH_SQL} LIMIT 1`,
    [runId],
  );
  return rows.length > 0;
}

export async function runMismatches(db: Db, runId: string): Promise<ChainMismatch[]> {
  return (await loadMismatches(db, [runId])).get(runId) ?? [];
}

/**
 * The chain allocated something other than what was reviewed: alert every org member in-app (once
 * per run) and add a dashboard activity entry. The run stays blocked (API refuses approve/fund/publish).
 */
export async function flagChainMismatch(db: Db, run: { id: string; organization_id: string; name: string }, txHash: string | null): Promise<void> {
  const created = await notifyEmployer(
    db,
    run.organization_id,
    {
      kind: "run_awaiting_approval",
      title: "Payroll run blocked: on-chain payments differ",
      body: `The payments recorded on-chain for "${run.name}" do not match the reviewed draft (a wallet, an amount or the claim window was changed). Do not approve or fund it. Cancel the run and create a new one.`,
      link: links.run(run.organization_id, run.id),
    },
    `chain_mismatch:${run.id}`,
  );
  if (created > 0) {
    // One activity entry per run (members added later still get their own notification).
    const seen = await db.query(`SELECT 1 FROM audit_logs WHERE action = 'run.chain_mismatch' AND resource_id = $1 LIMIT 1`, [run.id]);
    if (!seen.length) await audit(db, { orgId: run.organization_id, actor: "system", action: "run.chain_mismatch", resourceId: run.id, metadata: { name: run.name, txHash } });
  }
}

/**
 * payment_available for every claimable, matching item of a published run (idempotent). Called on
 * RunPublished, after a chain sync that finds the run published, and by the reminder pass before
 * it sends reminders, so a reminder never precedes the "you were paid" notice.
 */
export async function notifyPaymentsAvailable(db: Db, runId: string, now = new Date()): Promise<number> {
  const runs = await db.query<{ id: string; organization_id: string; claim_deadline: Date | null; org_name: string }>(
    `SELECT r.id, r.organization_id, r.claim_deadline, o.name AS org_name FROM payroll_runs r JOIN organizations o ON o.id = r.organization_id
     WHERE r.id = $1 AND r.status IN ('published', 'partially_claimed', 'completed') AND (r.claim_deadline IS NULL OR r.claim_deadline > $2)`,
    [runId, now],
  );
  const run = runs[0];
  if (!run) return 0;
  const items = await db.query<{ payment_id: string; recipient_address: string; email: string | null; amount: string }>(
    `SELECT i.payment_id::text AS payment_id, i.recipient_address, i.email, i.amount::text AS amount FROM payroll_items i
     WHERE i.payroll_run_id = $1 AND i.claim_status = 'allocated' AND i.payment_id IS NOT NULL AND NOT ${MISMATCH_SQL}
     ORDER BY i.item_index`,
    [run.id],
  );
  const deadline = run.claim_deadline ? new Date(run.claim_deadline).toUTCString() : null;
  let n = 0;
  for (const it of items) {
    const amt = weiToDecimalString(it.amount);
    const created = await notify(db, {
      orgId: run.organization_id, wallet: it.recipient_address, email: it.email, kind: "payment_available",
      title: `${run.org_name} sent you ${amt} MUSD`,
      body: `${run.org_name} sent you a payment of ${amt} MUSD. Claim it with wallet ${it.recipient_address}${deadline ? ` before ${deadline}` : ""}.`,
      link: links.claim(it.payment_id), dedupeKey: `payment_available:${it.payment_id}`,
    });
    if (created) n++;
  }
  return n;
}
