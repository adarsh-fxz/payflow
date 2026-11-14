import { getDb } from "@/lib/server/db";
import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { getSessionAddress } from "@/lib/server/session";
import { confirmClaim, parsePaymentId } from "@/lib/server/claims";
import { confirmTxSchema } from "@/lib/server/schemas";
import { limitByIp, limitByPayment } from "@/lib/server/ratelimit";

/** { txHash } → ClaimInfo. No session needed: it only records what the receipt's PaymentClaimed log
 *  proves (one getTransactionReceipt, no polling; not mined yet → 409, retry shortly). Rate-limited
 *  per client IP and per payment id. A session, when present, only unlocks the description. */
export async function POST(req: Request, ctx: RouteCtx<{ paymentId: string }>) {
  return handle(async () => {
    const db = getDb();
    await limitByIp(db, req, "claimConfirm");
    const { paymentId } = await ctx.params;
    const pid = parsePaymentId(paymentId);
    await limitByPayment(db, "claimConfirm", pid.toString());
    const { txHash } = await readJson(req, confirmTxSchema, 4096);
    const wallet = await getSessionAddress(db, req);
    return json(await confirmClaim(db, paymentId, txHash, wallet));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
