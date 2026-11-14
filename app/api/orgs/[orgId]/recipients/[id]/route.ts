import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { recipientDto } from "@/lib/server/dto";
import { deactivateRecipient, getRecipient, updateRecipient } from "@/lib/server/recipients";
import { recipientPatchSchema } from "@/lib/server/schemas";

type P = { orgId: string; id: string };

export async function GET(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    const { id } = await ctx.params;
    return json(recipientDto(await getRecipient(db, access.org.id, id)));
  });
}

export async function PATCH(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const { id } = await ctx.params;
    const input = await readJson(req, recipientPatchSchema, 16384);
    return json(await updateRecipient(db, wallet, access.org.id, id, input));
  });
}

export async function DELETE(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const { id } = await ctx.params;
    return json(await deactivateRecipient(db, wallet, access.org.id, id));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
