/**
 * PayFlow worker (Render background worker / local `npm run worker`).
 * Every tick: index escrow + registry events (2 confirmations, ≤5,000-block chunks), reconcile
 * touched runs from contract state, generate drafts for due schedules, send claim-expiry reminders,
 * and drain the email outbox. Safe to run alongside the API and other workers (idempotent writes).
 *
 *   npm run worker            # loop, every WORKER_INTERVAL_MS (default 15000)
 *   npm run worker -- --once  # single tick, then exit
 */
import { getDb } from "../lib/server/db";
import { workerTick } from "../lib/server/worker-tasks";

const once = process.argv.includes("--once");
const intervalMs = Math.max(2_000, Number(process.env.WORKER_INTERVAL_MS ?? 15_000));
let stopping = false;

function log(level: "info" | "error", msg: string, extra: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  if (level === "error") console.error(line);
  else console.log(line);
}

async function tick(): Promise<void> {
  const started = Date.now();
  try {
    const r = await workerTick(getDb(), { maxChunks: 20 });
    log("info", "tick", { ms: Date.now() - started, ...r });
  } catch (e) {
    log("error", "tick failed", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
}

async function main() {
  log("info", "worker starting", { once, intervalMs });
  if (once) {
    await tick();
    await getDb().close();
    return;
  }
  const shutdown = () => {
    stopping = true;
    log("info", "worker stopping");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  while (!stopping) {
    await tick();
    const until = Date.now() + intervalMs;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
  }
  await getDb().close();
}

main().catch((e) => {
  log("error", "worker crashed", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
  process.exit(1);
});
