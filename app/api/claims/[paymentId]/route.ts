import { getDb } from "@/lib/server/db";
import { handle, json, type RouteCtx } from "@/lib/server/http";
import { getSessionAddress } from "@/lib/server/session";
import { getClaimInfo } from "@/lib/server/claims";
import { limitByWalletAndIp } from "@/lib/server/ratelimit";

export async function GET(req: Request, ctx: RouteCtx<{ paymentId: string }>) {
  return handle(async () => {
    const db = getDb();
    const { paymentId } = await ctx.params;
    const wallet = await getSessionAddress(db, req);
    await limitByWalletAndIp(db, req, "claimInfo", wallet);
    return json(await getClaimInfo(db, paymentId, wallet));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
