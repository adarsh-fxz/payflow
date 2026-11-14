import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { deleteSchedule, updateSchedule } from "@/lib/server/schedules";
import { scheduleInputSchema } from "@/lib/server/schemas";

type P = { orgId: string; id: string };

export async function PATCH(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const { id } = await ctx.params;
    const input = await readJson(req, scheduleInputSchema.partial(), 2 * 1024 * 1024);
    return json(await updateSchedule(db, wallet, access.org.id, id, input));
  });
}

export async function DELETE(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const { id } = await ctx.params;
    await deleteSchedule(db, wallet, access.org.id, id);
    return json({ ok: true });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
