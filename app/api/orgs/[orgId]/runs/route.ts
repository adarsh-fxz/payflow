import { z } from "zod";
import { handle, json, readJson, readQuery, type RouteCtx } from "@/lib/server/http";
import { withOrg } from "@/lib/server/context";
import { MASK } from "@/lib/server/authz";
import { createRun, listRuns } from "@/lib/server/runs";
import { createRunSchema } from "@/lib/server/schemas";

const q = z.object({ status: z.enum(["draft", "onchain_draft", "pending_approval", "approved", "funded", "published", "partially_claimed", "completed", "cancelled", "expired"]).optional() });

export async function GET(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, access } = await withOrg(req, ctx.params, MASK.ANY_MEMBER);
    return json(await listRuns(db, access.org.id, readQuery(req, q).status));
  });
}

export async function POST(req: Request, ctx: RouteCtx<{ orgId: string }>) {
  return handle(async () => {
    const { db, wallet, access } = await withOrg(req, ctx.params, MASK.OPERATOR_OR_ADMIN);
    const input = await readJson(req, createRunSchema, 3 * 1024 * 1024);
    return json(await createRun(db, wallet, access.org, input), { status: 201 });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
