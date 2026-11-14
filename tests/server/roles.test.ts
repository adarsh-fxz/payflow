import "./helpers/env";
import { describe, expect, it } from "vitest";
import { canSetMemberRoles, hasRoleMask, MASK, requireOrgRole, rolesToNames } from "@/lib/server/authz";
import { actionMask } from "@/lib/server/runs";
import { ROLE } from "@/lib/chain/config";
import { createOrg } from "@/lib/server/orgs";
import { ApiHttpError } from "@/lib/server/http";
import { freshDb } from "./helpers/db";

describe("role permission helpers", () => {
  it("hasRoleMask matches the contract's `rolesOf & mask != 0` rule", () => {
    expect(hasRoleMask(ROLE.OPERATOR, MASK.OPERATOR_OR_ADMIN)).toBe(true);
    expect(hasRoleMask(ROLE.APPROVER, MASK.OPERATOR_OR_ADMIN)).toBe(false);
    expect(hasRoleMask(ROLE.APPROVER, MASK.RETURN_TO_DRAFT)).toBe(true);
    expect(hasRoleMask(ROLE.OPERATOR, MASK.ADMIN)).toBe(false);
    expect(hasRoleMask(ROLE.ADMIN, MASK.APPROVER)).toBe(false);
    expect(hasRoleMask(0, MASK.ANY_MEMBER)).toBe(false);
    expect(hasRoleMask(ROLE.APPROVER, MASK.ANY_MEMBER)).toBe(true);
    expect(hasRoleMask(7, MASK.OWNER)).toBe(false);
    expect(hasRoleMask(0, MASK.OWNER, true)).toBe(true);
  });

  it("actionMask follows the ARCHITECTURE role table", () => {
    expect(actionMask("create", "draft")).toBe(ROLE.OPERATOR | ROLE.ADMIN);
    expect(actionMask("approve", "pending_approval")).toBe(ROLE.APPROVER);
    expect(actionMask("return", "pending_approval")).toBe(ROLE.OPERATOR | ROLE.APPROVER | ROLE.ADMIN);
    expect(actionMask("return", "approved")).toBe(ROLE.ADMIN); // one operator/approver can't undo a reached threshold
    expect(actionMask("fund", "approved")).toBe(ROLE.ADMIN);
    expect(actionMask("cancel", "funded")).toBe(ROLE.ADMIN);
    expect(actionMask("cancel", "approved")).toBe(ROLE.ADMIN); // approved runs carry sign-off
    expect(actionMask("cancel", "pending_approval")).toBe(ROLE.OPERATOR | ROLE.ADMIN);
    // cancelPayment is draft-only on-chain now: no ADMIN-only funded path.
    expect(actionMask("cancel_payment", "onchain_draft")).toBe(ROLE.OPERATOR | ROLE.ADMIN);
    expect(actionMask("refund", "expired")).toBeNull(); // pays run.funder only, so anyone may trigger it
    // expireRun is permissionless after the deadline.
    expect(actionMask("expire", "published")).toBeNull();
  });

  it("canSetMemberRoles mirrors OrganizationRegistry: admins manage OPERATOR only", () => {
    const owner = { isOwner: true, roles: 7 };
    const admin = { isOwner: false, roles: ROLE.ADMIN };
    const approver = { isOwner: false, roles: ROLE.APPROVER };
    expect(canSetMemberRoles(owner, ROLE.ADMIN, ROLE.APPROVER)).toBe(true);
    expect(canSetMemberRoles(admin, 0, ROLE.OPERATOR)).toBe(true);
    expect(canSetMemberRoles(admin, ROLE.OPERATOR, 0)).toBe(true);
    expect(canSetMemberRoles(admin, 0, ROLE.APPROVER)).toBe(false);
    expect(canSetMemberRoles(admin, 0, ROLE.ADMIN)).toBe(false);
    expect(canSetMemberRoles(admin, 0, ROLE.OPERATOR | ROLE.APPROVER)).toBe(false);
    expect(canSetMemberRoles(admin, ROLE.APPROVER, 0)).toBe(false); // cannot strip an approver
    expect(canSetMemberRoles(admin, ROLE.APPROVER | ROLE.OPERATOR, ROLE.OPERATOR)).toBe(false);
    expect(canSetMemberRoles(approver, 0, ROLE.OPERATOR)).toBe(false);
  });

  it("rolesToNames", () => {
    expect(rolesToNames(7)).toEqual(["owner"]);
    expect(rolesToNames(6)).toEqual(["approver", "operator"]);
  });

  it("requireOrgRole checks DB members; non-members get not_found, wrong role forbidden", async () => {
    const db = await freshDb();
    const owner = "0x00000000000000000000000000000000000000a1";
    const op = "0x00000000000000000000000000000000000000a2";
    const removed = "0x00000000000000000000000000000000000000a3";
    const org = await createOrg(db, owner, { name: "Roles Co", description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 30 });
    await db.query(`INSERT INTO organization_members (id, organization_id, wallet_address, roles, status) VALUES ($1, $2, $3, 4, 'active'), ($4, $2, $5, 1, 'removed')`, [crypto.randomUUID(), org.id, op, crypto.randomUUID(), removed]);

    expect((await requireOrgRole(db, org.id, owner, MASK.ADMIN)).roles).toBe(7);
    expect((await requireOrgRole(db, org.id, op, MASK.OPERATOR_OR_ADMIN)).roles).toBe(4);
    await expect(requireOrgRole(db, org.id, op, MASK.ADMIN)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requireOrgRole(db, org.id, op, MASK.OWNER)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requireOrgRole(db, org.id, removed, MASK.ANY_MEMBER)).rejects.toMatchObject({ code: "not_found" });
    await expect(requireOrgRole(db, "not-a-uuid", owner, MASK.ANY_MEMBER)).rejects.toBeInstanceOf(ApiHttpError);
    await db.close();
  });
});
