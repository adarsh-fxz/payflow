import { handle, json, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { recoverOrg } from "@/lib/server/orgs";
import { limitByIp } from "@/lib/server/ratelimit";
import type { RecoverOrgResponse } from "@/lib/api-types";

/** Owner only. Finds this org's OrganizationCreated event on-chain and activates it → RecoverOrgResponse. */
export async function POST(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OWNER);
    await limitByIp(db, req, "txVerify");
    const res: RecoverOrgResponse = await recoverOrg(db, wallet, access.org);
    return json(res);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
