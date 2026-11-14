/** Per-request helpers for route handlers. */
import "./guard";
import { getDb, type Db } from "./db";
import { requireSession } from "./session";
import { requireOrgRole, type OrgAccess } from "./authz";

export interface OrgCtx {
  db: Db;
  wallet: string;
  access: OrgAccess;
}

export async function withOrg(req: Request, params: Promise<{ orgId: string }>, mask: number): Promise<OrgCtx> {
  const db = getDb();
  const wallet = await requireSession(db, req);
  const { orgId } = await params;
  const access = await requireOrgRole(db, orgId, wallet, mask);
  return { db, wallet, access };
}
