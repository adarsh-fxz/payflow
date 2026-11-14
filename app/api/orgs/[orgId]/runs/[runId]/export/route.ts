import { csvResponse, handle, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { loadRun, runExportCsv } from "@/lib/server/runs";

type P = { orgId: string; runId: string };

export async function GET(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    const { runId } = await ctx.params;
    const run = await loadRun(db, access.org.id, runId);
    return csvResponse(await runExportCsv(db, run), `${access.org.slug}-run-${run.chain_run_id ?? run.id.slice(0, 8)}.csv`);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
