import { handle, json, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { dashboardStats } from "@/lib/server/dashboard";

export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    return json(await dashboardStats(db, access.org.id));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
