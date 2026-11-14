import "./guard";
import { ALL_ROLES, ROLE } from "../chain/config";
import type { OrgRole } from "../api-types";
import type { Db } from "./db";
import { fail, parseUuid } from "./http";

export { ROLE, ALL_ROLES };

/** Masks per action (ARCHITECTURE role table). A caller passes when roles & mask != 0. */
export const MASK = {
  ANY_MEMBER: 0,
  ADMIN: ROLE.ADMIN,
  APPROVER: ROLE.APPROVER,
  OPERATOR_OR_ADMIN: ROLE.OPERATOR | ROLE.ADMIN,
  RETURN_TO_DRAFT: ROLE.OPERATOR | ROLE.APPROVER | ROLE.ADMIN,
  OWNER: -1,
} as const;

/** Pure permission check: mask 0 = any active member; -1 = owner only; else any overlapping bit. */
export function hasRoleMask(roles: number, mask: number, isOwner = false): boolean {
  if (isOwner) return true;
  if (mask === MASK.OWNER) return false;
  if (roles <= 0) return false;
  if (mask === 0) return true;
  return (roles & mask) !== 0;
}

export function rolesToNames(roles: number): OrgRole[] {
  if (roles === ALL_ROLES) return ["owner"];
  const out: OrgRole[] = [];
  if (roles & ROLE.ADMIN) out.push("admin");
  if (roles & ROLE.APPROVER) out.push("approver");
  if (roles & ROLE.OPERATOR) out.push("operator");
  return out;
}

export interface OrgRow {
  id: string;
  chain_org_id: string | null;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  owner_wallet: string;
  treasury_wallet: string | null;
  metadata_hash: string;
  default_claim_window_days: number;
  create_tx_hash: string | null;
  status: string;
  created_at: Date;
  owner_email?: string | null;
  chain_metadata_hash?: string | null;
}

export interface OrgAccess {
  org: OrgRow;
  roles: number;
  isOwner: boolean;
}

/** Caller's effective roles: owner → 7; else the active member row's bitmask; else 0. */
export async function rolesFor(db: Db, org: OrgRow, wallet: string): Promise<number> {
  if (org.owner_wallet === wallet.toLowerCase()) return ALL_ROLES;
  const m = await db.query<{ roles: number }>(
    `SELECT roles FROM organization_members WHERE organization_id = $1 AND wallet_address = $2 AND status = 'active'`,
    [org.id, wallet.toLowerCase()],
  );
  return Number(m[0]?.roles ?? 0);
}

export async function loadOrg(db: Db, orgId: string): Promise<OrgRow> {
  const id = parseUuid(orgId, "Organization");
  const rows = await db.query<OrgRow>(`SELECT * FROM organizations WHERE id = $1`, [id]);
  if (!rows[0]) throw fail("not_found", "Organization not found");
  return rows[0];
}

/**
 * Loads the org and checks the session wallet's DB roles (synced from MemberRolesSet).
 * Non-members get 404 (no existence leak); members lacking the role get 403.
 */
export async function requireOrgRole(db: Db, orgId: string, wallet: string, mask: number): Promise<OrgAccess> {
  const org = await loadOrg(db, orgId);
  const isOwner = org.owner_wallet === wallet.toLowerCase();
  const roles = await rolesFor(db, org, wallet);
  if (!isOwner && roles === 0) throw fail("not_found", "Organization not found");
  if (!hasRoleMask(roles, mask, isOwner)) throw fail("forbidden", "Your role in this organization does not allow this action");
  return { org, roles, isOwner };
}

/**
 * Mirrors OrganizationRegistry.setMemberRoles: the owner may set anything; an ADMIN may only grant or
 * remove OPERATOR on members that hold no other role. ADMIN and APPROVER are owner-only.
 */
export function canSetMemberRoles(actor: { isOwner: boolean; roles: number }, currentRoles: number, newRoles: number): boolean {
  if (actor.isOwner) return true;
  if ((actor.roles & ROLE.ADMIN) === 0) return false;
  const nonOperator = ~ROLE.OPERATOR;
  return (newRoles & nonOperator) === 0 && (currentRoles & nonOperator) === 0;
}
