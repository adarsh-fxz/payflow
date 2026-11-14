import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { confirmOrg } from "@/lib/server/orgs";
import { confirmTxSchema } from "@/lib/server/schemas";
import { limitByIp } from "@/lib/server/ratelimit";

export async function POST(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OWNER);
    await limitByIp(db, req, "txVerify");
    const { txHash } = await readJson(req, confirmTxSchema, 4096);
    return json(await confirmOrg(db, wallet, access.org, txHash));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
