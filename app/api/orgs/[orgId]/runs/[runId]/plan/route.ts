import { handle, json, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { loadRun, runPlan } from "@/lib/server/runs";

type P = { orgId: string; runId: string };

/** Operators build the txs; approvers also read expectedPaymentsHash before approve(). */
export async function GET(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN | MASK.APPROVER);
    const { runId } = await ctx.params;
    return json(await runPlan(db, await loadRun(db, access.org.id, runId)));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
