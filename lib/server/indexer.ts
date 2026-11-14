/**
 * Shared, idempotent event indexing. Used by the worker loop, POST /api/indexer/sync, the per-tx
 * verification in /runs/:id/tx and /claims/:id/confirm, and member/org confirmation.
 *
 * Dedupe: every log is inserted into indexed_events (PK chain_id, tx hash, log index) inside the
 * same transaction as its effects; a log that is already present is skipped, so replaying the same
 * transaction (API + worker concurrently, or a retried request) is a no-op.
 * Effects never move a run backwards except via the explicit return-to-draft transition, and
 * money totals that only grow on-chain (claimed) are applied with GREATEST.
 */
import "./guard";
import { MEZO_TESTNET_ID, contracts, splitPaymentId, ALL_ROLES, ROLE } from "../chain/config";
import type { RunStatus } from "../api-types";
import { weiToDecimalString } from "../money";
import type { Db } from "./db";
import type { ChainLog } from "./chain";
import { notify, notifyEmployer } from "./notifications";
import { links } from "./links";
import { audit } from "./audit";
import type { ItemRow, RunRow } from "./dto";
import { flagChainMismatch, hasMismatch, notifyPaymentsAvailable } from "./lifecycle";

const S = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v));
const lc = (v: unknown) => String(v).toLowerCase();

export function argsToJson(log: ChainLog): string {
  return JSON.stringify({ ...log.args, _blockTime: log.blockTimestamp ? log.blockTimestamp.toISOString() : null }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  /** DB run ids whose state changed. */
  touchedRuns: Set<string>;
}

/** Applies logs in (block, logIndex) order. Each log is its own transaction. */
export async function applyLogs(db: Db, logs: ChainLog[], chainId: number = MEZO_TESTNET_ID): Promise<ApplyResult> {
  const sorted = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const res: ApplyResult = { applied: 0, skipped: 0, touchedRuns: new Set() };
  for (const log of sorted) {
    const touched = await db.transaction(async (tx) => {
      const ins = await tx.query(
        `INSERT INTO indexed_events (chain_id, contract_address, event_name, transaction_hash, block_number, log_index, args_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT DO NOTHING RETURNING log_index`,
        [chainId, lc(log.address), log.eventName, lc(log.transactionHash), log.blockNumber.toString(), log.logIndex, argsToJson(log)],
      );
      if (ins.length === 0) return null;
      return (await applyEvent(tx, log)) ?? "";
    });
    if (touched === null) res.skipped++;
    else {
      res.applied++;
      if (touched) res.touchedRuns.add(touched);
    }
  }
  return res;
}

async function runByChainId(db: Db, runId: unknown): Promise<(RunRow & { org_name: string }) | null> {
  const rows = await db.query<RunRow & { org_name: string }>(
    `SELECT r.*, o.name AS org_name FROM payroll_runs r JOIN organizations o ON o.id = r.organization_id WHERE r.chain_run_id = $1`,
    [S(runId)],
  );
  return rows[0] ?? null;
}

/** Guarded status change: only from the listed statuses. Returns true when updated. */
async function moveStatus(db: Db, runId: string, to: RunStatus, from: RunStatus[]): Promise<boolean> {
  const r = await db.query(`UPDATE payroll_runs SET status = $2, updated_at = now() WHERE id = $1 AND status = ANY($3::text[]) RETURNING id`, [runId, to, `{${from.join(",")}}`]);
  return r.length > 0;
}

/** total_amount / recipient_count = non-cancelled items. */
export async function recomputeTotals(db: Db, runId: string): Promise<void> {
  await db.query(
    `UPDATE payroll_runs SET
       total_amount = COALESCE((SELECT sum(amount) FROM payroll_items WHERE payroll_run_id = $1 AND claim_status <> 'cancelled'), 0),
       recipient_count = (SELECT count(*) FROM payroll_items WHERE payroll_run_id = $1 AND claim_status <> 'cancelled'),
       updated_at = now()
     WHERE id = $1`,
    [runId],
  );
}

/** published ↔ partially_claimed ↔ completed from claimed vs allocated. */
export async function deriveClaimStatus(db: Db, runId: string): Promise<RunStatus | null> {
  const rows = await db.query<{ status: RunStatus }>(
    `UPDATE payroll_runs SET status = CASE
        WHEN claimed_amount > 0 AND claimed_amount >= total_amount THEN 'completed'
        WHEN claimed_amount > 0 THEN 'partially_claimed'
        ELSE 'published' END,
      updated_at = now()
     WHERE id = $1 AND status IN ('published', 'partially_claimed', 'completed') RETURNING status`,
    [runId],
  );
  return rows[0]?.status ?? null;
}

async function applyEvent(db: Db, log: ChainLog): Promise<string | null> {
  const a = log.args;
  const txHash = lc(log.transactionHash);
  const evKey = `${txHash}:${log.logIndex}`;
  const at = log.blockTimestamp ?? new Date();
  const isEscrow = lc(log.address) === lc(contracts.escrow);
  const isRegistry = lc(log.address) === lc(contracts.registry);

  if (isRegistry || (!isEscrow && ["OrganizationCreated", "MemberRolesSet", "OwnershipTransferred", "MetadataUpdated"].includes(log.eventName))) {
    await applyRegistryEvent(db, log, txHash);
    return null;
  }

  switch (log.eventName) {
    case "RunCreated": {
      const rows = await db.query<RunRow>(
        `SELECT r.* FROM payroll_runs r JOIN organizations o ON o.id = r.organization_id WHERE r.run_ref = $1 AND o.chain_org_id = $2`,
        [lc(a.runRef), S(a.orgId)],
      );
      const run = rows[0];
      if (!run) return null; // created outside PayFlow, or for another org: nothing to map to
      if (run.chain_run_id != null && S(run.chain_run_id) !== S(a.runId)) return null;
      const windowSec = Number(a.claimWindow);
      // The reviewed claim window is never overwritten: the chain value is stored beside it, and a
      // difference blocks the run (approvers sign the window as part of paymentsHash).
      await db.query(
        `UPDATE payroll_runs SET chain_run_id = $2, create_tx_hash = COALESCE(create_tx_hash, $3), chain_claim_window_seconds = $4,
           status = CASE WHEN status = 'draft' THEN 'onchain_draft' ELSE status END, updated_at = now()
         WHERE id = $1`,
        [run.id, S(a.runId), txHash, windowSec],
      );
      if (windowSec !== Number(run.claim_window_days) * 86400) await flagChainMismatch(db, run, txHash);
      await notifyEmployer(db, run.organization_id, { kind: "run_created", title: "Payroll run created on-chain", body: `"${run.name}" was created on Mezo and is ready for payments.`, link: links.run(run.organization_id, run.id) }, `run_created:${evKey}`, ROLE.ADMIN | ROLE.OPERATOR);
      return run.id;
    }
    case "PaymentAllocated": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      const { index } = splitPaymentId(BigInt(S(a.paymentId)));
      const recipient = lc(a.recipient);
      const amount = S(a.amount);
      const items = await db.query<ItemRow>(`SELECT * FROM payroll_items WHERE payroll_run_id = $1 AND item_index = $2`, [run.id, index]);
      const item = items[0];
      let mismatch: boolean;
      if (item) {
        // The reviewed recipient/amount are NEVER overwritten: the chain values are stored beside them.
        // Unreviewed placeholders (no draft item at this index) simply mirror the chain.
        const reviewed = item.reviewed !== false;
        mismatch = !reviewed || item.recipient_address !== recipient || S(item.amount) !== amount;
        await db.query(
          `UPDATE payroll_items SET payment_id = $2, chain_recipient_address = $3, chain_amount = $4, allocate_tx_hash = COALESCE(allocate_tx_hash, $5),
             recipient_address = CASE WHEN reviewed THEN recipient_address ELSE $3 END,
             amount = CASE WHEN reviewed THEN amount ELSE $4::numeric END,
             claim_status = CASE WHEN claim_status = 'pending' THEN 'allocated' ELSE claim_status END
           WHERE id = $1`,
          [item.id, S(a.paymentId), recipient, amount, txHash],
        );
      } else {
        mismatch = true;
        await insertUnreviewedItem(db, run.id, index, recipient, amount, S(a.paymentId), "allocated", txHash);
      }
      await recomputeTotals(db, run.id);
      if (mismatch) await flagChainMismatch(db, run, txHash);
      return run.id;
    }
    case "PaymentCancelled": {
      // Draft-only on-chain (the approved list is frozen after submit), so recipients were never told.
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      await db.query(`UPDATE payroll_items SET claim_status = 'cancelled' WHERE payroll_run_id = $1 AND payment_id = $2`, [run.id, S(a.paymentId)]);
      await recomputeTotals(db, run.id);
      return run.id;
    }
    case "RunSubmitted": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      await db.query(`UPDATE payroll_runs SET approvals_required = $2 WHERE id = $1`, [run.id, Number(a.approvalsRequired ?? 1)]);
      await moveStatus(db, run.id, "pending_approval", ["draft", "onchain_draft"]);
      // Notifications follow the event (deduped), not the status transition: a chain sync may already
      // have moved the status, and the notice must still go out exactly once.
      // A run blocked by a chain mismatch must not be approved, so approvers are not asked to (the
      // members already got the "blocked" alert from flagChainMismatch).
      if (await hasMismatch(db, run.id)) return run.id;
      await notifyEmployer(db, run.organization_id, { kind: "run_awaiting_approval", title: "Payroll run needs approval", body: `"${run.name}" (${weiToDecimalString(S(a.allocated))} MUSD, ${S(a.paymentCount)} payments) is waiting for approval.`, link: links.run(run.organization_id, run.id) }, `run_awaiting_approval:${evKey}`, ROLE.APPROVER);
      return run.id;
    }
    case "RunApproved": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      await db.query(
        `INSERT INTO payment_approvals (id, payroll_run_id, approver_wallet, status, approved_at, tx_hash) VALUES ($1, $2, $3, 'approved', $4, $5)`,
        [crypto.randomUUID(), run.id, lc(a.approver), at, txHash],
      );
      const sub = await db.query<{ args_json: { approvalsRequired?: string | number } }>(
        `SELECT args_json FROM indexed_events WHERE event_name = 'RunSubmitted' AND contract_address = $1 AND args_json->>'runId' = $2
         ORDER BY block_number DESC, log_index DESC LIMIT 1`,
        [lc(log.address), S(a.runId)],
      );
      const required = Number(sub[0]?.args_json.approvalsRequired ?? run.approvals_required ?? 1);
      // `approvals` counts only approvers who still hold APPROVER (PayrollEscrow._validApprovals).
      if (Number(a.approvals) >= required) {
        if (await moveStatus(db, run.id, "approved", ["pending_approval", "onchain_draft"])) {
          await db.query(`UPDATE payroll_runs SET approved_by = $2 WHERE id = $1`, [run.id, lc(a.approver)]);
        }
        await notifyEmployer(db, run.organization_id, { kind: "run_approved", title: "Payroll run approved", body: `"${run.name}" is approved and ready to fund.`, link: links.run(run.organization_id, run.id) }, `run_approved:${evKey}`, ROLE.ADMIN);
      }
      return run.id;
    }
    case "RunReturnedToDraft": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      await moveStatus(db, run.id, "onchain_draft", ["pending_approval", "approved"]);
      await db.query(`UPDATE payroll_runs SET approved_by = NULL WHERE id = $1`, [run.id]);
      await db.query(
        `INSERT INTO payment_approvals (id, payroll_run_id, approver_wallet, status, approved_at, tx_hash) VALUES ($1, $2, $3, 'rejected', $4, $5)`,
        [crypto.randomUUID(), run.id, lc(a.by), at, txHash],
      );
      return run.id;
    }
    case "RunFunded": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      await db.query(
        `UPDATE payroll_runs SET funder_wallet = $2, funded_amount = $3, fund_tx_hash = $4, updated_at = now() WHERE id = $1`,
        [run.id, lc(a.funder), S(a.amount), txHash],
      );
      await moveStatus(db, run.id, "funded", ["onchain_draft", "pending_approval", "approved"]);
      await notifyEmployer(db, run.organization_id, { kind: "run_funded", title: "Payroll run funded", body: `"${run.name}" was funded with ${weiToDecimalString(S(a.amount))} MUSD.`, link: links.run(run.organization_id, run.id) }, `run_funded:${evKey}`, ROLE.ADMIN);
      return run.id;
    }
    case "RunPublished": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      const deadline = new Date(Number(S(a.claimDeadline)) * 1000);
      await db.query(`UPDATE payroll_runs SET claim_deadline = $2, publish_tx_hash = $3, updated_at = now() WHERE id = $1`, [run.id, deadline, txHash]);
      await moveStatus(db, run.id, "published", ["onchain_draft", "pending_approval", "approved", "funded"]);
      await deriveClaimStatus(db, run.id);
      await notifyEmployer(db, run.organization_id, { kind: "run_published", title: "Payroll run published", body: `"${run.name}" is live. Recipients can now claim until ${deadline.toUTCString()}.`, link: links.run(run.organization_id, run.id) }, `run_published:${evKey}`);
      await notifyPaymentsAvailable(db, run.id);
      return run.id;
    }
    case "PaymentClaimed": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      const pid = S(a.paymentId);
      const ins = await db.query(
        `INSERT INTO payment_claims (id, payroll_run_id, payment_id, recipient_address, amount, claimed_at, transaction_hash, block_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (payment_id) DO NOTHING RETURNING id`,
        [crypto.randomUUID(), run.id, pid, lc(a.recipient), S(a.amount), at, txHash, log.blockNumber.toString()],
      );
      const items = await db.query<ItemRow>(
        `UPDATE payroll_items SET claim_status = 'claimed', transaction_hash = $3, claimed_at = $4
         WHERE payroll_run_id = $1 AND payment_id = $2 RETURNING *`,
        [run.id, pid, txHash, at],
      );
      await db.query(
        `UPDATE payroll_runs SET
           claimed_amount = GREATEST(claimed_amount, COALESCE((SELECT sum(amount) FROM payment_claims WHERE payroll_run_id = $1), 0)),
           claimed_count = GREATEST(claimed_count, (SELECT count(*) FROM payment_claims WHERE payroll_run_id = $1)::int),
           updated_at = now()
         WHERE id = $1`,
        [run.id],
      );
      const status = await deriveClaimStatus(db, run.id);
      if (ins.length > 0) {
        const it = items[0];
        const amt = weiToDecimalString(S(a.amount));
        await notify(db, { orgId: run.organization_id, wallet: lc(a.recipient), email: it?.email ?? null, kind: "payment_received", title: `You received ${amt} MUSD`, body: `Your ${amt} MUSD payment from ${run.org_name} was claimed to your wallet.`, link: links.claim(pid), dedupeKey: `payment_received:${pid}` });
        await notifyEmployer(db, run.organization_id, { kind: "payment_claimed", title: "Payment claimed", body: `${it?.name ?? lc(a.recipient)} claimed ${amt} MUSD from "${run.name}".`, link: links.run(run.organization_id, run.id) }, `payment_claimed:${pid}`, ROLE.ADMIN);
        if (status === "completed") {
          await notifyEmployer(db, run.organization_id, { kind: "run_completed", title: "Payroll run completed", body: `Every payment in "${run.name}" has been claimed.`, link: links.run(run.organization_id, run.id) }, `run_completed:${run.id}`);
        }
      }
      return run.id;
    }
    case "RunCancelled": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      await moveStatus(db, run.id, "cancelled", ["draft", "onchain_draft", "pending_approval", "approved", "funded"]);
      await db.query(`UPDATE payroll_items SET claim_status = 'cancelled' WHERE payroll_run_id = $1 AND claim_status IN ('pending', 'allocated')`, [run.id]);
      // A funded run was visible to recipients as "upcoming": tell them it will not be paid.
      if (BigInt(S(run.funded_amount ?? 0).split(".")[0]!) > 0n) {
        const items = await db.query<ItemRow>(
          `SELECT * FROM payroll_items WHERE payroll_run_id = $1 AND payment_id IS NOT NULL AND claim_status = 'cancelled' AND reviewed
             AND (chain_recipient_address IS NULL OR chain_recipient_address = recipient_address)`,
          [run.id],
        );
        for (const it of items) {
          await notify(db, { orgId: run.organization_id, wallet: it.recipient_address, email: it.email, kind: "payment_cancelled", title: `Payment from ${run.org_name} cancelled`, body: `The ${weiToDecimalString(S(it.amount))} MUSD payment from ${run.org_name} was cancelled before it was published.`, link: links.myPayments(), dedupeKey: `payment_cancelled:${S(it.payment_id)}` });
        }
      }
      return run.id;
    }
    case "RunExpired": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      await moveStatus(db, run.id, "expired", ["published", "partially_claimed", "completed", "funded"]);
      await db.query(`UPDATE payroll_items SET claim_status = 'expired' WHERE payroll_run_id = $1 AND claim_status = 'allocated'`, [run.id]);
      // Includes items a chain sync already marked expired (the notice follows the event, deduped).
      const expired = await db.query<ItemRow>(
        `SELECT * FROM payroll_items WHERE payroll_run_id = $1 AND claim_status = 'expired' AND payment_id IS NOT NULL AND reviewed
           AND (chain_recipient_address IS NULL OR chain_recipient_address = recipient_address)`,
        [run.id],
      );
      for (const it of expired) {
        await notify(db, { orgId: run.organization_id, wallet: it.recipient_address, email: it.email, kind: "payment_expired", title: `Payment from ${run.org_name} expired`, body: `The claim window for your ${weiToDecimalString(S(it.amount))} MUSD payment from ${run.org_name} has closed. Contact them if you still need to be paid.`, link: links.myPayments(), dedupeKey: `payment_expired:${S(it.payment_id)}` });
      }
      return run.id;
    }
    case "Refunded": {
      const run = await runByChainId(db, a.runId);
      if (!run) return null;
      await db.query(`UPDATE payroll_runs SET refunded_amount = refunded_amount + $2, updated_at = now() WHERE id = $1`, [run.id, S(a.amount)]);
      return run.id;
    }
    default:
      return null;
  }
}

/** Placeholder for an on-chain payment that has no reviewed draft item (always reported as a mismatch). */
export async function insertUnreviewedItem(db: Db, runId: string, index: number, recipient: string, amount: string, paymentId: string, status: string, txHash: string | null, claimedAt: Date | null = null): Promise<void> {
  await db.query(
    `INSERT INTO payroll_items (id, payroll_run_id, item_index, name, recipient_address, amount, payment_id, claim_status, allocate_tx_hash,
       chain_recipient_address, chain_amount, reviewed, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $5, $6, false, $10) ON CONFLICT (payroll_run_id, item_index) DO NOTHING`,
    [crypto.randomUUID(), runId, index, "Not in the reviewed draft", recipient, amount, paymentId, status, txHash, claimedAt],
  );
}

async function upsertMember(db: Db, orgId: string, wallet: string, roles: number, txHash: string, email: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO organization_members (id, organization_id, wallet_address, roles, status, tx_hash, email)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organization_id, wallet_address) DO UPDATE SET roles = EXCLUDED.roles, status = EXCLUDED.status, tx_hash = EXCLUDED.tx_hash,
       email = COALESCE(organization_members.email, EXCLUDED.email)`,
    [crypto.randomUUID(), orgId, wallet, roles, roles === 0 ? "removed" : "active", txHash, email],
  );
}

/**
 * Activates the earliest pending org of `owner` whose metadata hash matches an OrganizationCreated
 * event (used by the indexer and by POST /orgs/:id/recover). Returns the activated org id or null.
 */
export async function activatePendingOrg(db: Db, ev: { orgId: string; owner: string; metadataHash: string; txHash: string }, onlyOrgId?: string): Promise<string | null> {
  const existing = await db.query(`SELECT id FROM organizations WHERE chain_org_id = $1`, [ev.orgId]);
  if (existing.length) return null;
  const rows = await db.query<{ id: string; owner_email: string | null }>(
    `UPDATE organizations SET chain_org_id = $1, status = 'active', create_tx_hash = $2, chain_metadata_hash = $4
     WHERE id = (SELECT id FROM organizations WHERE owner_wallet = $3 AND metadata_hash = $4 AND chain_org_id IS NULL AND status = 'pending'
                   AND ($5::uuid IS NULL OR id = $5::uuid) ORDER BY created_at LIMIT 1)
     RETURNING id, owner_email`,
    [ev.orgId, ev.txHash, lc(ev.owner), lc(ev.metadataHash), onlyOrgId ?? null],
  );
  const org = rows[0];
  if (!org) return null;
  await upsertMember(db, org.id, lc(ev.owner), ALL_ROLES, ev.txHash, org.owner_email);
  await audit(db, { orgId: org.id, actor: lc(ev.owner), action: "org.confirm", resourceId: org.id, metadata: { txHash: ev.txHash, chainOrgId: ev.orgId } });
  return org.id;
}

async function applyRegistryEvent(db: Db, log: ChainLog, txHash: string): Promise<void> {
  const a = log.args;
  switch (log.eventName) {
    case "OrganizationCreated": {
      await activatePendingOrg(db, { orgId: S(a.orgId), owner: lc(a.owner), metadataHash: lc(a.metadataHash), txHash });
      return;
    }
    case "MetadataUpdated": {
      await db.query(`UPDATE organizations SET chain_metadata_hash = $2 WHERE chain_org_id = $1`, [S(a.orgId), lc(a.metadataHash)]);
      return;
    }
    case "MemberRolesSet": {
      const org = await db.query<{ id: string }>(`SELECT id FROM organizations WHERE chain_org_id = $1`, [S(a.orgId)]);
      if (!org[0]) return;
      await upsertMember(db, org[0].id, lc(a.member), Number(a.roles), txHash);
      return;
    }
    case "OwnershipTransferred": {
      const org = await db.query<{ id: string }>(`UPDATE organizations SET owner_wallet = $2 WHERE chain_org_id = $1 RETURNING id`, [S(a.orgId), lc(a.to)]);
      if (!org[0]) return;
      await upsertMember(db, org[0].id, lc(a.to), ALL_ROLES, txHash);
      await upsertMember(db, org[0].id, lc(a.from), 0, txHash);
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------------------------
// Block-range indexer pass
// ---------------------------------------------------------------------------------------------

export const CURSOR_NAME = "payflow";
export const MAX_CHUNK = 5000n;

export interface IndexerSource {
  latestBlock(): Promise<bigint>;
  fetchLogs(from: bigint, to: bigint): Promise<ChainLog[]>;
}

export interface IndexerPassResult {
  fromBlock: string | null;
  toBlock: string | null;
  applied: number;
  skipped: number;
  touchedRuns: string[];
  caughtUp: boolean;
}

export async function getCursor(db: Db): Promise<bigint | null> {
  const r = await db.query<{ last_block: string }>(`SELECT last_block FROM indexer_cursor WHERE name = $1`, [CURSOR_NAME]);
  return r[0] ? BigInt(r[0].last_block) : null;
}

async function setCursor(db: Db, block: bigint): Promise<void> {
  await db.query(
    `INSERT INTO indexer_cursor (name, last_block, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET last_block = GREATEST(indexer_cursor.last_block, EXCLUDED.last_block), updated_at = now()`,
    [CURSOR_NAME, block.toString()],
  );
}

/**
 * Reads logs from the cursor (or deployBlock) up to latest - confirmations, in chunks of ≤5,000
 * blocks, applying each chunk before advancing the cursor. Safe to run concurrently with itself
 * and the API (dedupe + GREATEST cursor).
 */
export async function runIndexerPass(
  db: Db,
  source: IndexerSource,
  opts: { confirmations?: number; maxChunks?: number; deployBlock?: bigint; chunkSize?: bigint } = {},
): Promise<IndexerPassResult> {
  const confirmations = BigInt(opts.confirmations ?? 2);
  const chunk = opts.chunkSize && opts.chunkSize > 0n && opts.chunkSize <= MAX_CHUNK ? opts.chunkSize : MAX_CHUNK;
  const maxChunks = opts.maxChunks ?? 20;
  const deployBlock = opts.deployBlock ?? contracts.deployBlock;
  const head = (await source.latestBlock()) - confirmations;
  const cursor = await getCursor(db);
  let from = cursor === null ? deployBlock : cursor + 1n;
  const result: IndexerPassResult = { fromBlock: null, toBlock: null, applied: 0, skipped: 0, touchedRuns: [], caughtUp: from > head };
  const touched = new Set<string>();
  for (let i = 0; i < maxChunks && from <= head; i++) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    const logs = await source.fetchLogs(from, to);
    const r = await applyLogs(db, logs);
    result.applied += r.applied;
    result.skipped += r.skipped;
    r.touchedRuns.forEach((id) => touched.add(id));
    await setCursor(db, to);
    if (result.fromBlock === null) result.fromBlock = from.toString();
    result.toBlock = to.toString();
    from = to + 1n;
  }
  result.caughtUp = from > head;
  result.touchedRuns = [...touched];
  return result;
}
