import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/server/db";
import { errorResponse, fail, handle, json } from "@/lib/server/http";
import { workerTick } from "@/lib/server/worker-tasks";

function authorized(req: Request): boolean {
  const secret = process.env.INDEXER_SECRET;
  if (!secret || secret.length < 16) throw fail("forbidden", "Indexer endpoint is disabled (INDEXER_SECRET not set)");
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One worker tick (indexer pass + reconciliation + schedules + reminders + email outbox).
 * 200 only when the indexer pass succeeded (or there is nothing deployed to index); a failed pass is
 * 503 chain_unavailable (RPC) or 500 internal, with the tick result in error.details, so cron
 * monitors see the failure.
 */
export async function POST(req: Request) {
  return handle(async () => {
    if (!authorized(req)) throw fail("unauthenticated", "Invalid indexer secret");
    const tick = await workerTick(getDb(), { maxChunks: 5 });
    if ("error" in tick.indexer) {
      return tick.indexer.unavailable
        ? errorResponse("chain_unavailable", `Indexer pass failed: ${tick.indexer.error}`, tick)
        : errorResponse("internal", `Indexer pass failed: ${tick.indexer.error}`, tick);
    }
    return json(tick);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
