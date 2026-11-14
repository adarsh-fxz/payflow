import { getDb } from "@/lib/server/db";
import { handle, json, readJson, type RouteCtx } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session";
import { loadOrg, requireOrgRole, rolesFor, MASK, type OrgAccess } from "@/lib/server/authz";
import { applyRunTx, loadRun } from "@/lib/server/runs";
import { runTxSchema } from "@/lib/server/schemas";
import { limitByIp } from "@/lib/server/ratelimit";

type P = { orgId: string; runId: string };

/**
 * RunTxRequest → verifies the receipt + events against the DB (per-action role check inside) → PayrollRunDetail.
 * "expire" is permissionless on-chain, so any signed-in wallet may report it (the RunExpired event is
 * still verified). A wallet that is not a member gets only `{ ok: true, status }`, never the run's data.
 */
export async function POST(req: Request, ctx: RouteCtx<P>) {
  return handle(async () => {
    const db = getDb();
    const wallet = await requireSession(db, req);
    await limitByIp(db, req, "txVerify");
    const { orgId, runId } = await ctx.params;
    const body = await readJson(req, runTxSchema, 8192);
    let access: OrgAccess;
    if (body.action === "expire") {
      const org = await loadOrg(db, orgId);
      const roles = await rolesFor(db, org, wallet);
      access = { org, roles, isOwner: org.owner_wallet === wallet };
    } else {
      access = await requireOrgRole(db, orgId, wallet, MASK.ANY_MEMBER);
    }
    const run = await loadRun(db, access.org.id, runId);
    const detail = await applyRunTx(db, wallet, access, run, body);
    if (!access.isOwner && access.roles === 0) return json({ ok: true, status: detail.status });
    return json(detail);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
