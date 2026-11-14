import { z } from "zod";
import { csvResponse, handle, readQuery, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { paymentsReportStream } from "@/lib/server/dashboard";

const q = z.object({ status: z.enum(["pending", "allocated", "claimed", "cancelled", "expired"]).optional() });

/** Streamed (paged) CSV of every payment item; formula-safe. */
export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    const { status } = readQuery(req, q);
    return csvResponse(paymentsReportStream(db, access.org.id, status), `${access.org.slug}-payments${status ? "-" + status : ""}.csv`);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
