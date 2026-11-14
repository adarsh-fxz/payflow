import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { createSchedule, listSchedules } from "@/lib/server/schedules";
import { scheduleInputSchema } from "@/lib/server/schemas";

export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    return json(await listSchedules(db, access.org.id));
  });
}

export async function POST(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const input = await readJson(req, scheduleInputSchema, 2 * 1024 * 1024);
    return json(await createSchedule(db, wallet, access.org.id, input), { status: 201 });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
