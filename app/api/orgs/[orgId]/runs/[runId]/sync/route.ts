import { handle, json, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { loadRun, syncRun } from "@/lib/server/runs";
import { limitByIp } from "@/lib/server/ratelimit";

type P = { orgId: string; runId: string };

export async function POST(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    await limitByIp(db, req, "txVerify");
    const { runId } = await ctx.params;
    return json(await syncRun(db, wallet, access.org, await loadRun(db, access.org.id, runId)));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
