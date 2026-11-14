import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { deleteRun, loadRun, runDetail, updateRun } from "@/lib/server/runs";
import { updateRunSchema } from "@/lib/server/schemas";

type P = { orgId: string; runId: string };

export async function GET(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    const { runId } = await ctx.params;
    return json(await runDetail(db, await loadRun(db, access.org.id, runId)));
  });
}

export async function PATCH(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const { runId } = await ctx.params;
    const run = await loadRun(db, access.org.id, runId);
    const input = await readJson(req, updateRunSchema, 3 * 1024 * 1024);
    return json(await updateRun(db, wallet, access.org, run, input));
  });
}

export async function DELETE(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const { runId } = await ctx.params;
    await deleteRun(db, wallet, access.org, await loadRun(db, access.org.id, runId));
    return json({ ok: true });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
