import { handle, json, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { reportsSummary } from "@/lib/server/dashboard";
import type { ReportsSummary } from "@/lib/api-types";

/** → ReportsSummary (SQL aggregates; lists are bounded). */
export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    const body: ReportsSummary = await reportsSummary(db, access.org.id);
    return json(body);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
