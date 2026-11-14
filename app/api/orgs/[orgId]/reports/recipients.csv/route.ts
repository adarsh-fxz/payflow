import { csvResponse, handle, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { recipientsReportStream } from "@/lib/server/dashboard";

/** ReportsSummary.recipients for every payee as a streamed, formula-safe CSV. */
export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    return csvResponse(recipientsReportStream(db, access.org.id), `${access.org.slug}-recipients-report.csv`);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
