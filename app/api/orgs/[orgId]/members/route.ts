import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { listMembers, upsertMember } from "@/lib/server/orgs";
import { upsertMemberSchema } from "@/lib/server/schemas";
import { limitByIp } from "@/lib/server/ratelimit";

export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    return json(await listMembers(db, access.org.id));
  });
}

export async function POST(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.ADMIN);
    await limitByIp(db, req, "txVerify");
    const input = await readJson(req, upsertMemberSchema, 8192);
    return json(await upsertMember(db, wallet, access, input));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
