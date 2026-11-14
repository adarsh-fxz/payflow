import { ROLE } from "@/lib/chain/config";
import type { RolesMask } from "@/lib/api-types";

export const has = (mask: RolesMask | null | undefined, bit: number) => ((mask ?? 0) & bit) !== 0;
export const canOperate = (m: RolesMask) => has(m, ROLE.OPERATOR) || has(m, ROLE.ADMIN);
export const canApprove = (m: RolesMask) => has(m, ROLE.APPROVER);
export const canAdmin = (m: RolesMask) => has(m, ROLE.ADMIN);
/** PendingApproval: operator, approver or admin. Approved: admin only (PayrollEscrow.returnToDraft). */
export const canReturn = (m: RolesMask, status?: string) =>
  status === "approved" ? has(m, ROLE.ADMIN) : has(m, ROLE.OPERATOR) || has(m, ROLE.APPROVER) || has(m, ROLE.ADMIN);

export function roleNames(mask: RolesMask): string[] {
  const out: string[] = [];
  if (has(mask, ROLE.ADMIN)) out.push("Admin");
  if (has(mask, ROLE.APPROVER)) out.push("Approver");
  if (has(mask, ROLE.OPERATOR)) out.push("Operator");
  return out;
}

/** True when the mask holds nothing but OPERATOR (or nothing at all). */
export const onlyOperator = (roles: RolesMask) => (roles & ~ROLE.OPERATOR) === 0;

/** On-chain rule: the owner sets any role; an admin may only add or remove OPERATOR on members with no other role. */
export function canManageMember(opts: { isOwner: boolean; admin: boolean; memberRoles: RolesMask }): boolean {
  return opts.isOwner || (opts.admin && onlyOperator(opts.memberRoles));
}
