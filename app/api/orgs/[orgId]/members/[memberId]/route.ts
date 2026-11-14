import { fail, handle, json, parseUuid, readQuery, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { removeMember } from "@/lib/server/orgs";
import { confirmTxSchema } from "@/lib/server/schemas";
import { limitByIp } from "@/lib/server/ratelimit";

export async function DELETE(req: Request, ctx: RouteCtx<{ orgId: string; memberId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.ADMIN);
    await limitByIp(db, req, "txVerify");
    const { memberId } = await ctx.params;
    const q = readQuery(req, confirmTxSchema.partial());
    if (!q.txHash) throw fail("invalid_input", "txHash query parameter is required (the setMemberRoles(…, 0) transaction)");
    return json(await removeMember(db, wallet, access, parseUuid(memberId, "Member"), q.txHash));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
