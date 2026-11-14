import { handle, json, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { reconciliation } from "@/lib/server/dashboard";

/** ReconciliationReport (+ `truncated`; header x-payflow-truncated: true when only the 200 most recent runs were compared). */
export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    const report = await reconciliation(db, access.org.id);
    return json(report, { headers: report.truncated ? { "x-payflow-truncated": "true" } : {} });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
