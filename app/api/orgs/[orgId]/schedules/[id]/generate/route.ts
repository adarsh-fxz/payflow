import { handle, json, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { generateDraft, loadSchedule } from "@/lib/server/schedules";

type P = { orgId: string; id: string };

/** Creates an off-chain draft run now (does not advance nextRunAt). → { run: PayrollRunDetail, skipped }. */
export async function POST(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const { id } = await ctx.params;
    const s = await loadSchedule(db, access.org.id, id);
    return json(await generateDraft(db, wallet, access.org, s, new Date()), { status: 201 });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
