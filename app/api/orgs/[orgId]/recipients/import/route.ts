import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { importRecipients } from "@/lib/server/recipients";
import { csvBodySchema } from "@/lib/server/schemas";
import { limitByIp } from "@/lib/server/ratelimit";

/** Body { csv }. 200 → { imported, updated, report }. Any invalid row → 400 invalid_input with the CsvValidationReport in error.details. */
export async function POST(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    await limitByIp(db, req, "csv");
    const { csv } = await readJson(req, csvBodySchema, 3 * 1024 * 1024);
    return json(await importRecipients(db, wallet, access.org.id, csv));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
