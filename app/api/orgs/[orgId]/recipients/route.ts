import { handle, json, readJson, readQuery, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { createRecipient, listRecipients } from "@/lib/server/recipients";
import { recipientInputSchema, recipientQuerySchema } from "@/lib/server/schemas";

export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    return json(await listRecipients(db, access.org.id, readQuery(req, recipientQuerySchema)));
  });
}

export async function POST(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const input = await readJson(req, recipientInputSchema, 16384);
    return json(await createRecipient(db, wallet, access.org.id, input), { status: 201 });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
