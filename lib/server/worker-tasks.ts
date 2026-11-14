/** One worker tick: index chain events, reconcile touched runs, schedules → drafts, reminders, email outbox. */
import "./guard";
import { isDeployed } from "../chain/config";
import type { Db } from "./db";
import { fetchLogs, latestBlock, readPayments, readRun } from "./chain";
import { runIndexerPass, type IndexerPassResult } from "./indexer";
import { applyChainState } from "./runsync";
import type { RunRow } from "./dto";
import { generateDueSchedules } from "./schedules";
import { sendExpiryReminders } from "./reminders";
import { sendOutbox } from "./email";
import { isChainUnavailable } from "./chain-errors";
import { mapLimit } from "./concurrency";

export interface TickResult {
  indexer: IndexerPassResult | { skipped: "not_deployed" } | { error: string; unavailable: boolean };
  reconciled: number;
  schedules: { generated: number; failed: number };
  reminders: { recipients: number; employers: number };
  email: { sent: number; failed: number; skipped: number; retrying: number };
}

/** Most runs reconciled per call; the rest are picked up on the next tick (their events are indexed already). */
export const RECONCILE_CAP = 200;

/** Re-reads touched runs from the chain with bounded concurrency. Per-run failures are counted, not thrown. */
export async function reconcileRuns(db: Db, runIds: string[], concurrency = 4): Promise<number> {
  const ids = [...new Set(runIds)].slice(0, RECONCILE_CAP);
  const done = await mapLimit(ids, concurrency, async (id) => {
    const rows = await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1 AND chain_run_id IS NOT NULL`, [id]);
    const run = rows[0];
    if (!run) return 0;
    try {
      const chain = await readRun(BigInt(run.chain_run_id!));
      await applyChainState(db, run, chain, await readPayments(BigInt(run.chain_run_id!), chain.paymentCount));
      return 1;
    } catch (e) {
      console.error(JSON.stringify({ level: "warn", msg: "reconcile failed", runId: id, error: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
      return 0;
    }
  });
  return done.reduce<number>((a, b) => a + b, 0);
}

export async function workerTick(db: Db, opts: { maxChunks?: number; confirmations?: number } = {}): Promise<TickResult> {
  let indexer: TickResult["indexer"];
  let reconciled = 0;
  if (!isDeployed) indexer = { skipped: "not_deployed" };
  else {
    try {
      const r = await runIndexerPass(db, { latestBlock, fetchLogs }, { maxChunks: opts.maxChunks, confirmations: opts.confirmations });
      indexer = r;
      reconciled = await reconcileRuns(db, r.touchedRuns);
    } catch (e) {
      indexer = { error: e instanceof Error ? e.message.split("\n")[0]!.slice(0, 300) : String(e), unavailable: isChainUnavailable(e) };
    }
  }
  const schedules = await generateDueSchedules(db);
  const reminders = await sendExpiryReminders(db);
  const email = await sendOutbox(db);
  // Housekeeping: expired auth state and stale rate-limit windows.
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await db.query(`DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 day'`);
  await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  return { indexer, reconciled, schedules, reminders, email };
}
