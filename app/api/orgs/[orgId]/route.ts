import { isDeployed } from "@/lib/chain/config";
import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { orgDto } from "@/lib/server/dto";
import { recoverHint, updateOrg } from "@/lib/server/orgs";
import { updateOrgSchema } from "@/lib/server/schemas";

/**
 * Organization. While status is "pending" and the org is older than a minute, the response carries
 * `x-payflow-recover: available`: the createOrganization tx may have been mined without the confirm
 * call reaching us, so the owner should try POST /api/orgs/:orgId/recover before creating it again.
 */
export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    const headers: Record<string, string> = {};
    if (isDeployed && access.isOwner && recoverHint(access.org)) headers["x-payflow-recover"] = "available";
    return json(orgDto(access.org, access.roles), { headers });
  });
}

/** → Organization & { metadataChanged }. When metadataChanged, also `x-payflow-metadata: stale` (see orgs.updateOrg). */
export async function PATCH(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.ADMIN);
    const input = await readJson(req, updateOrgSchema);
    const org = await updateOrg(db, wallet, access.org, input);
    return json(org, { headers: org.metadataChanged ? { "x-payflow-metadata": "stale" } : {} });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
