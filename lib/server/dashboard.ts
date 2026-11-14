/** Org dashboard, reconciliation and payment reports — all computed from indexed DB data (+ live chain for reconciliation). */
import "./guard";
import type { ActivityItem, DashboardStats, Hex, ReconciliationReport, ReconciliationRow, ReportsSummary, RunStatus } from "../api-types";
import { contracts } from "../chain/config";
import { toCsv } from "../csv/validate";
import { itemStatus } from "@/lib/client/status";
import type { ItemClaimStatus, RunStatus as ApiRunStatus } from "@/lib/api-types";
import { weiToDecimalString } from "../money";
import type { Db } from "./db";
import { iso, runLiability, type RunRow } from "./dto";
import { chainError, readEscrowTotals, readRun, requireDeployed, type ChainRun } from "./chain";
import { isChainUnavailable } from "./chain-errors";
import { mapLimit } from "./concurrency";
import { chainStatusToRunStatus } from "./runsync";

const sumBig = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const big = (v: unknown) => BigInt(String(v ?? "0").split(".")[0] || "0");

/** SQL for a run's liability (allocated - claimed while funded/published) and refundable, mirroring PayrollEscrow. */
const LIABILITY_SQL = `CASE WHEN r.status IN ('funded', 'published', 'partially_claimed', 'completed') THEN GREATEST(r.total_amount - r.claimed_amount, 0) ELSE 0 END`;
const REFUNDABLE_SQL = `GREATEST(r.funded_amount - r.claimed_amount - r.refunded_amount - ${LIABILITY_SQL}, 0)`;

/** Last 12 UTC months, oldest first ("YYYY-MM"). */
function last12Months(now: Date): string[] {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

/** Monthly funded (indexed RunFunded events) and claimed (payment_claims) volume, SQL-aggregated. */
export async function monthlyVolume(db: Db, orgId: string, now = new Date()): Promise<DashboardStats["monthlyVolume"]> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const funded = await db.query<{ month: string; wei: string }>(
    `SELECT to_char(date_trunc('month', COALESCE((e.args_json->>'_blockTime')::timestamptz, e.processed_at)), 'YYYY-MM') AS month,
            sum((e.args_json->>'amount')::numeric)::text AS wei
     FROM indexed_events e JOIN payroll_runs r ON r.chain_run_id = (e.args_json->>'runId')::numeric
     WHERE e.event_name = 'RunFunded' AND e.contract_address = $2 AND r.organization_id = $1
       AND COALESCE((e.args_json->>'_blockTime')::timestamptz, e.processed_at) >= $3
     GROUP BY 1`,
    [orgId, contracts.escrow.toLowerCase(), since],
  );
  const claims = await db.query<{ month: string; wei: string }>(
    `SELECT to_char(date_trunc('month', c.claimed_at), 'YYYY-MM') AS month, sum(c.amount)::text AS wei
     FROM payment_claims c JOIN payroll_runs r ON r.id = c.payroll_run_id WHERE r.organization_id = $1 AND c.claimed_at >= $2 GROUP BY 1`,
    [orgId, since],
  );
  const fMap = new Map(funded.map((f) => [f.month, f.wei]));
  const cMap = new Map(claims.map((c) => [c.month, c.wei]));
  return last12Months(now).map((m) => ({ month: m, fundedWei: big(fMap.get(m)).toString(), claimedWei: big(cMap.get(m)).toString() }));
}

/** Every figure is a SQL aggregate or a bounded query; nothing loads all runs or items into memory. */
export async function dashboardStats(db: Db, orgId: string, now = new Date()): Promise<DashboardStats> {
  const totals = (
    await db.query<{ runs: string; claimed: string; allocated: string; outstanding: string; refundable: string }>(
      `SELECT count(*)::text AS runs,
              COALESCE(sum(r.claimed_amount), 0)::text AS claimed,
              COALESCE(sum(CASE WHEN r.status IN ('funded', 'published', 'partially_claimed', 'completed') THEN r.funded_amount ELSE 0 END), 0)::text AS allocated,
              COALESCE(sum(${LIABILITY_SQL}), 0)::text AS outstanding,
              COALESCE(sum(${REFUNDABLE_SQL}), 0)::text AS refundable
       FROM payroll_runs r WHERE r.organization_id = $1`,
      [orgId],
    )
  )[0]!;

  const rc = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM recipients WHERE organization_id = $1 AND status = 'active'`, [orgId]);

  const upcomingRuns = await db.query<{ id: string; schedule_id: string | null; name: string; scheduled_at: Date; total_amount: string }>(
    `SELECT id, schedule_id, name, scheduled_at, total_amount::text AS total_amount FROM payroll_runs
     WHERE organization_id = $1 AND status IN ('draft', 'onchain_draft', 'pending_approval', 'approved') AND scheduled_at >= $2
     ORDER BY scheduled_at LIMIT 10`,
    [orgId, new Date(now.getTime() - 86400_000)],
  );
  const schedules = await db.query<{ id: string; name: string; next_run_at: Date; items_json: { amount: string }[] }>(
    `SELECT id, name, next_run_at, items_json FROM payroll_schedules WHERE organization_id = $1 AND active = true ORDER BY next_run_at LIMIT 10`,
    [orgId],
  );
  const upcoming = [
    ...upcomingRuns.map((r) => ({ runId: r.id, scheduleId: r.schedule_id, name: r.name, date: iso(r.scheduled_at)!, amountWei: big(r.total_amount).toString() })),
    ...schedules.map((s) => ({
      runId: null,
      scheduleId: s.id,
      name: s.name,
      date: iso(s.next_run_at)!,
      amountWei: sumBig((Array.isArray(s.items_json) ? s.items_json : []).map((i) => big(i.amount))).toString(),
    })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 10);

  const logs = await db.query<{ id: string; action: string; resource_id: string | null; metadata: Record<string, unknown>; timestamp: Date }>(
    `SELECT id, action, resource_id, metadata, timestamp FROM audit_logs WHERE organization_id = $1 ORDER BY timestamp DESC LIMIT 20`,
    [orgId],
  );
  const runIds = [...new Set(logs.map((l) => l.resource_id).filter((v): v is string => !!v && /^[0-9a-f-]{36}$/i.test(v)))];
  const names = runIds.length
    ? await db.query<{ id: string; name: string }>(`SELECT id, name FROM payroll_runs WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [orgId, `{${runIds.join(",")}}`])
    : [];
  const runNames = new Map(names.map((r) => [r.id, r.name]));
  const recentActivity: ActivityItem[] = logs.map((l) => activityFromAudit(l, runNames));

  const cc = await db.query<{ claim_status: string; n: string }>(
    `SELECT i.claim_status, count(*)::text AS n FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id
     WHERE r.organization_id = $1 AND r.status IN ('published', 'partially_claimed', 'completed', 'expired') GROUP BY 1`,
    [orgId],
  );
  const ccMap = new Map(cc.map((c) => [c.claim_status, Number(c.n)]));

  return {
    totalPaidWei: big(totals.claimed).toString(),
    totalAllocatedWei: big(totals.allocated).toString(),
    totalClaimedWei: big(totals.claimed).toString(),
    outstandingWei: big(totals.outstanding).toString(),
    refundableWei: big(totals.refundable).toString(),
    recipientCount: Number(rc[0]?.n ?? 0),
    runCount: Number(totals.runs),
    upcoming,
    recentActivity,
    monthlyVolume: await monthlyVolume(db, orgId, now),
    claimCompletion: {
      claimed: ccMap.get("claimed") ?? 0,
      unclaimed: ccMap.get("allocated") ?? 0,
      cancelled: ccMap.get("cancelled") ?? 0,
      expired: ccMap.get("expired") ?? 0,
    },
  };
}

const ACTION_TITLES: Record<string, string> = {
  "org.create": "Organization created",
  "org.confirm": "Organization confirmed on-chain",
  "org.update": "Organization settings updated",
  "member.set_roles": "Member roles updated",
  "member.remove": "Member removed",
  "recipient.create": "Recipient added",
  "recipient.update": "Recipient updated",
  "recipient.deactivate": "Recipient deactivated",
  "recipient.import": "Recipients imported",
  "run.create": "Payroll draft created",
  "run.update": "Payroll draft edited",
  "run.delete": "Payroll draft deleted",
  "run.sync": "Run synced from chain",
  "run.tx.create": "Run created on-chain",
  "run.tx.allocate": "Payments added on-chain",
  "run.tx.submit": "Run submitted for approval",
  "run.tx.approve": "Run approved",
  "run.tx.return": "Run returned to draft",
  "run.tx.fund": "Run funded",
  "run.tx.publish": "Run published",
  "run.tx.cancel": "Run cancelled",
  "run.tx.cancel_payment": "Payment cancelled",
  "run.tx.expire": "Run expired",
  "run.tx.refund": "Refund sent",
  "run.chain_mismatch": "Run blocked: on-chain payments differ from the review",
  "run.payments_hash_mismatch": "Run blocked: on-chain commitment differs",
  "org.recover": "Organization recovered from chain",
  "org.metadata_confirm": "Organization details saved on-chain",
  "schedule.create": "Schedule created",
  "schedule.update": "Schedule updated",
  "schedule.delete": "Schedule deleted",
  "schedule.generate": "Draft generated from schedule",
};

function activityFromAudit(
  l: { id: string; action: string; resource_id: string | null; metadata: Record<string, unknown>; timestamp: Date },
  runNames: Map<string, string>,
): ActivityItem {
  const m = l.metadata ?? {};
  const runName = l.resource_id ? runNames.get(l.resource_id) : undefined;
  const detail = runName ?? (typeof m.name === "string" ? m.name : typeof m.member === "string" ? m.member : typeof m.wallet === "string" ? m.wallet : "");
  const tx = typeof m.txHash === "string" && /^0x[0-9a-f]{64}$/.test(m.txHash) ? (m.txHash as Hex) : null;
  const amount = typeof m.amountWei === "string" && /^\d+$/.test(m.amountWei) ? m.amountWei : null;
  return { id: l.id, kind: l.action, title: ACTION_TITLES[l.action] ?? l.action, detail, amountWei: amount, txHash: tx, at: iso(l.timestamp)! };
}

/** Pure: compares a DB run with live chain state. */
export function reconcileRow(r: RunRow, chain: ChainRun | null): ReconciliationRow {
  const db = {
    fundedWei: big(r.funded_amount).toString(),
    allocatedWei: big(r.total_amount).toString(),
    claimedWei: big(r.claimed_amount).toString(),
    refundedWei: big(r.refunded_amount).toString(),
    outstandingWei: runLiability(r).toString(),
  };
  let chainVals: ReconciliationRow["chain"] = null;
  let matches = chain === null ? r.chain_run_id == null : false;
  if (chain) {
    const st = chainStatusToRunStatus(chain.status);
    const liable = st === "funded" || st === "published";
    const liability = liable ? chain.allocated - chain.claimed : 0n;
    const refundable = chain.funded - chain.claimed - chain.refunded - liability;
    chainVals = {
      fundedWei: chain.funded.toString(),
      allocatedWei: chain.allocated.toString(),
      claimedWei: chain.claimed.toString(),
      refundedWei: chain.refunded.toString(),
      outstandingWei: liability.toString(),
      refundableWei: refundable.toString(),
    };
    // A DB draft still being allocated legitimately has more planned than allocated on-chain. A
    // cancelled run owes nobody anything, so its planned total is irrelevant: only the money that
    // actually moved (funded / claimed / refunded / outstanding) has to agree.
    const allocMatch = r.status === "onchain_draft" || r.status === "cancelled" ? true : db.allocatedWei === chainVals.allocatedWei;
    matches =
      allocMatch &&
      db.fundedWei === chainVals.fundedWei &&
      db.claimedWei === chainVals.claimedWei &&
      db.refundedWei === chainVals.refundedWei &&
      db.outstandingWei === chainVals.outstandingWei &&
      statusMatches(r.status as RunStatus, st);
  }
  return { runId: r.id, chainRunId: r.chain_run_id == null ? null : String(r.chain_run_id), name: r.name, status: r.status as RunStatus, db, chain: chainVals, matches };
}

function statusMatches(dbStatus: RunStatus, chainStatus: RunStatus | null): boolean {
  if (chainStatus === "published") return dbStatus === "published" || dbStatus === "partially_claimed" || dbStatus === "completed";
  return dbStatus === chainStatus;
}

/** Reconciliation reads at most this many (most recent) runs from the chain per request. */
export const RECONCILE_LIMIT = 200;

/**
 * ReconciliationReport plus `truncated: true` (and header x-payflow-truncated) when the org has more
 * than RECONCILE_LIMIT on-chain runs; only the most recent ones are compared. Chain reads run with
 * bounded concurrency; an RPC outage fails the whole report (503) instead of reporting false drift.
 */
export async function reconciliation(db: Db, orgId: string): Promise<ReconciliationReport & { truncated: boolean }> {
  requireDeployed();
  const runs = await db.query<RunRow>(
    `SELECT * FROM payroll_runs WHERE organization_id = $1 AND status <> 'draft' ORDER BY created_at DESC LIMIT $2`,
    [orgId, RECONCILE_LIMIT + 1],
  );
  const truncated = runs.length > RECONCILE_LIMIT;
  const subset = runs.slice(0, RECONCILE_LIMIT);
  const rows = await mapLimit(subset, 8, async (r) => {
    let chain: ChainRun | null = null;
    if (r.chain_run_id != null) {
      try {
        chain = await readRun(BigInt(r.chain_run_id));
      } catch (e) {
        if (isChainUnavailable(e)) throw chainError(e);
        chain = null; // run unknown to this escrow: reported as not matching
      }
    }
    return reconcileRow(r, chain);
  });
  const escrow = await readEscrowTotals();
  const pick = (k: "fundedWei" | "allocatedWei" | "claimedWei" | "outstandingWei" | "refundableWei") =>
    sumBig(rows.map((x) => (x.chain ? BigInt(x.chain[k]) : 0n))).toString();
  return {
    generatedAt: new Date().toISOString(),
    rows,
    totals: { fundedWei: pick("fundedWei"), allocatedWei: pick("allocatedWei"), claimedWei: pick("claimedWei"), outstandingWei: pick("outstandingWei"), refundableWei: pick("refundableWei") },
    allMatch: rows.every((r) => r.matches),
    escrow: { address: contracts.escrow.toLowerCase() as Hex, totalHeldWei: escrow.totalHeld.toString(), balanceWei: escrow.balance.toString() },
    truncated,
  };
}

const PAYMENT_COLUMNS = ["run_name", "chain_run_id", "run_status", "item_index", "name", "email", "department", "recipient_address", "amount", "amount_wei", "description", "payment_id", "status", "claim_status", "transaction_hash", "claimed_at", "claim_deadline"];
export const CSV_PAGE = 2000;

/** Streams a CSV built page by page (keyset pagination), so memory stays flat for any org size. */
function csvStream<Row extends Record<string, unknown>, K>(
  columns: string[],
  fetchPage: (after: K | null) => Promise<{ rows: Row[]; next: K | null }>,
  mapRow: (r: Row) => Record<string, unknown>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let after: K | null = null;
  let started = false;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return controller.close();
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(toCsv([], columns)));
      }
      const page = await fetchPage(after);
      if (page.rows.length) {
        const body = toCsv(page.rows.map(mapRow), columns);
        controller.enqueue(enc.encode(body.slice(body.indexOf("\r\n") + 2)));
      }
      if (page.next === null) {
        done = true;
        controller.close();
      } else after = page.next;
    },
  });
}

type PaymentCsvRow = Record<string, unknown> & { run_created_at: Date; run_id: string; item_index: number; amount: string };
type PaymentCursor = { createdAt: Date; runId: string; index: number };

export function paymentsReportStream(db: Db, orgId: string, status?: string): ReadableStream<Uint8Array> {
  return csvStream<PaymentCsvRow, PaymentCursor>(
    PAYMENT_COLUMNS,
    async (after) => {
      const rows = await db.query<PaymentCsvRow>(
        `SELECT r.created_at AS run_created_at, r.id AS run_id, r.name AS run_name, r.chain_run_id::text AS chain_run_id, r.status AS run_status,
                i.item_index, i.name, i.email, i.department, i.recipient_address, i.amount::text AS amount, i.description,
                i.payment_id::text AS payment_id, i.claim_status, i.transaction_hash, i.claimed_at, r.claim_deadline
         FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id
         WHERE r.organization_id = $1 AND ($2::text IS NULL OR i.claim_status = $2)
           AND ($3::timestamptz IS NULL OR (r.created_at, r.id, i.item_index) < ($3::timestamptz, $4::uuid, $5::int))
         ORDER BY r.created_at DESC, r.id DESC, i.item_index DESC
         LIMIT $6`,
        [orgId, status ?? null, after?.createdAt ?? null, after?.runId ?? null, after?.index ?? null, CSV_PAGE],
      );
      const last = rows[rows.length - 1];
      return { rows, next: rows.length === CSV_PAGE && last ? { createdAt: last.run_created_at, runId: last.run_id, index: Number(last.item_index) } : null };
    },
    (r) => ({ ...r, amount_wei: r.amount, amount: weiToDecimalString(String(r.amount)), status: itemStatus(r.claim_status as ItemClaimStatus, r.run_status as ApiRunStatus).label }),
  );
}

/** Whole CSV as text (tests / small exports). */
export async function paymentsReportCsv(db: Db, orgId: string, status?: string): Promise<string> {
  return new Response(paymentsReportStream(db, orgId, status)).text();
}

// ---------------------------------------------------------------------------------------------
// Reports summary + recipients CSV
// ---------------------------------------------------------------------------------------------

const SUMMARY_LIST_LIMIT = 100;
const SUMMARY_UNCLAIMED_LIMIT = 500;
const SUMMARY_RECIPIENT_LIMIT = 500;

/** Payee rollup over allocated payments (payment_id set), newest-paid first; keyset on (recipient_address). */
const RECIPIENT_ROLLUP_SQL = `
  SELECT i.recipient_address,
         COALESCE(max(rc.name), max(i.name)) AS name,
         count(*)::int AS payment_count,
         COALESCE(sum(CASE WHEN i.claim_status = 'claimed' THEN i.amount ELSE 0 END), 0)::text AS paid_wei,
         COALESCE(sum(CASE WHEN i.claim_status = 'allocated' AND r.status IN ('published', 'partially_claimed') THEN i.amount ELSE 0 END), 0)::text AS unclaimed_wei,
         max(i.claimed_at) AS last_paid_at
  FROM payroll_items i
  JOIN payroll_runs r ON r.id = i.payroll_run_id
  LEFT JOIN recipients rc ON rc.organization_id = r.organization_id AND rc.wallet_address = i.recipient_address
  WHERE r.organization_id = $1 AND i.payment_id IS NOT NULL AND i.reviewed
    AND r.status IN ('funded', 'published', 'partially_claimed', 'completed', 'expired', 'cancelled')
    AND ($2::text IS NULL OR i.recipient_address > $2)
  GROUP BY i.recipient_address`;

interface RecipientRollupRow { recipient_address: string; name: string; payment_count: number; paid_wei: string; unclaimed_wei: string; last_paid_at: Date | null }
const rollupDto = (r: RecipientRollupRow): ReportsSummary["recipients"][number] => ({
  recipientAddress: r.recipient_address as Hex,
  name: r.name,
  paymentCount: Number(r.payment_count),
  paidWei: big(r.paid_wei).toString(),
  unclaimedWei: big(r.unclaimed_wei).toString(),
  lastPaidAt: iso(r.last_paid_at),
});

export async function reportsSummary(db: Db, orgId: string, now = new Date()): Promise<ReportsSummary> {
  const t = (
    await db.query<{ runs: string; completed: string; published: string; funded: string; claimed: string; outstanding: string; refunded: string }>(
      `SELECT count(*)::text AS runs,
              count(*) FILTER (WHERE r.status = 'completed')::text AS completed,
              count(*) FILTER (WHERE r.status IN ('published', 'partially_claimed', 'completed'))::text AS published,
              COALESCE(sum(r.funded_amount), 0)::text AS funded,
              COALESCE(sum(r.claimed_amount), 0)::text AS claimed,
              COALESCE(sum(${LIABILITY_SQL}), 0)::text AS outstanding,
              COALESCE(sum(r.refunded_amount), 0)::text AS refunded
       FROM payroll_runs r WHERE r.organization_id = $1`,
      [orgId],
    )
  )[0]!;
  const completed = await db.query<{ id: string; name: string; completed_at: Date | null; total_amount: string; recipient_count: number }>(
    `SELECT r.id, r.name, (SELECT max(c.claimed_at) FROM payment_claims c WHERE c.payroll_run_id = r.id) AS completed_at,
            r.total_amount::text AS total_amount, r.recipient_count
     FROM payroll_runs r WHERE r.organization_id = $1 AND r.status = 'completed' ORDER BY r.updated_at DESC LIMIT $2`,
    [orgId, SUMMARY_LIST_LIMIT],
  );
  const unclaimed = await db.query<{ run_id: string; run_name: string; payment_id: string; name: string; recipient_address: string; amount: string; claim_deadline: Date | null }>(
    `SELECT r.id AS run_id, r.name AS run_name, i.payment_id::text AS payment_id, i.name, i.recipient_address, i.amount::text AS amount, r.claim_deadline
     FROM payroll_items i JOIN payroll_runs r ON r.id = i.payroll_run_id
     WHERE r.organization_id = $1 AND r.status IN ('published', 'partially_claimed') AND i.claim_status = 'allocated' AND i.payment_id IS NOT NULL
     ORDER BY r.claim_deadline NULLS LAST, r.id, i.item_index LIMIT $2`,
    [orgId, SUMMARY_UNCLAIMED_LIMIT],
  );
  const outstanding = await db.query<{ id: string; name: string; outstanding: string; claim_deadline: Date | null }>(
    `SELECT r.id, r.name, (${LIABILITY_SQL})::text AS outstanding, r.claim_deadline FROM payroll_runs r
     WHERE r.organization_id = $1 AND (${LIABILITY_SQL}) > 0 ORDER BY r.claim_deadline NULLS LAST LIMIT $2`,
    [orgId, SUMMARY_LIST_LIMIT],
  );
  const recipients = await db.query<RecipientRollupRow>(
    `SELECT * FROM (${RECIPIENT_ROLLUP_SQL}) x ORDER BY x.last_paid_at DESC NULLS LAST, x.recipient_address LIMIT $3`,
    [orgId, null, SUMMARY_RECIPIENT_LIMIT],
  );
  return {
    generatedAt: now.toISOString(),
    payroll: {
      runs: Number(t.runs),
      completedRuns: Number(t.completed),
      publishedRuns: Number(t.published),
      fundedWei: big(t.funded).toString(),
      claimedWei: big(t.claimed).toString(),
      outstandingWei: big(t.outstanding).toString(),
      refundedWei: big(t.refunded).toString(),
    },
    completedRuns: completed.map((r) => ({ runId: r.id, name: r.name, completedAt: iso(r.completed_at), totalWei: big(r.total_amount).toString(), recipientCount: Number(r.recipient_count) })),
    unclaimed: unclaimed.map((u) => ({ runId: u.run_id, runName: u.run_name, paymentId: u.payment_id, name: u.name, recipientAddress: u.recipient_address as Hex, amountWei: big(u.amount).toString(), claimDeadline: iso(u.claim_deadline) })),
    outstandingByRun: outstanding.map((o) => ({ runId: o.id, name: o.name, outstandingWei: big(o.outstanding).toString(), claimDeadline: iso(o.claim_deadline) })),
    monthlyVolume: await monthlyVolume(db, orgId, now),
    recipients: recipients.map(rollupDto),
  };
}

const RECIPIENT_COLUMNS = ["name", "recipient_address", "payment_count", "paid", "paid_wei", "unclaimed", "unclaimed_wei", "last_paid_at"];

/** The summary's recipients block as CSV, every payee (keyset-paged by wallet), formula-safe via toCsv. */
export function recipientsReportStream(db: Db, orgId: string): ReadableStream<Uint8Array> {
  return csvStream<RecipientRollupRow & Record<string, unknown>, string>(
    RECIPIENT_COLUMNS,
    async (after) => {
      const rows = await db.query<RecipientRollupRow & Record<string, unknown>>(
        `SELECT * FROM (${RECIPIENT_ROLLUP_SQL}) x ORDER BY x.recipient_address LIMIT $3`,
        [orgId, after, CSV_PAGE],
      );
      const last = rows[rows.length - 1];
      return { rows, next: rows.length === CSV_PAGE && last ? last.recipient_address : null };
    },
    (r) => {
      const d = rollupDto(r);
      return {
        name: d.name, recipient_address: d.recipientAddress, payment_count: d.paymentCount,
        paid: weiToDecimalString(d.paidWei), paid_wei: d.paidWei, unclaimed: weiToDecimalString(d.unclaimedWei), unclaimed_wei: d.unclaimedWei,
        last_paid_at: d.lastPaidAt,
      };
    },
  );
}
