import { csvResponse, handle, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { exportRecipientsCsv } from "@/lib/server/recipients";

export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    return csvResponse(await exportRecipientsCsv(db, access.org.id), `${access.org.slug}-recipients.csv`);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
