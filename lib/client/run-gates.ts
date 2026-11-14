import type { PayrollItem, PayrollRun, PayrollRunDetail, RolesMask } from "@/lib/api-types";
import { getAddress } from "viem";
import { weiToDecimalString } from "@/lib/money";
import { canAdmin, canOperate } from "./roles";
import { itemStatus } from "./status";

/**
 * Pure gating for the run's on-chain steps, so the UI and the tests agree on when a step is
 * blocked and why. The contract is still the final word; this only keeps the UI from offering
 * actions that would revert or that should not be taken.
 */
export type RunStep = "approve" | "fund" | "publish";

type GateRun = Pick<PayrollRun, "status" | "validApprovals" | "approvalsRequired"> & { chainMismatch?: PayrollRun["chainMismatch"] | null };

export function hasChainMismatch(run: Pick<GateRun, "chainMismatch">): boolean {
  return (run.chainMismatch?.length ?? 0) > 0;
}

/** null when the step may go ahead; otherwise the sentence to show instead of the button. */
export function stepBlock(run: GateRun, step: RunStep): string | null {
  if (hasChainMismatch(run)) {
    return "What's on-chain differs from the list that was reviewed, so this run is blocked. Cancel it and build a new one.";
  }
  if (step === "fund" && run.validApprovals !== null && run.approvalsRequired !== null && run.validApprovals < run.approvalsRequired) {
    return approvalsShortfall(run.validApprovals, run.approvalsRequired);
  }
  return null;
}

export function approvalsShortfall(valid: number, required: number): string {
  return `Funding is blocked: only ${valid} of ${required} approvals still count, because an approver lost the approver role after signing. Give that wallet the approver role again, or return the run to draft and collect new approvals.`;
}

/** Mismatch panel sentence; once the run is cancelled there is nothing left to do but rebuild. */
/** Plain wording for a claim window in seconds ("30 days", "1 hour"). */
export function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  return `${seconds.toLocaleString()} seconds`;
}

export function mismatchSummary(count: number, cancelled: boolean, windowDiffers = false): string {
  if (count === 0 && windowDiffers) {
    if (cancelled) return "The claim window on-chain is different from the one your team saved, so the run was cancelled. No MUSD was paid out.";
    return "The claim window on-chain is different from the one your team saved. Approving, funding and publishing are turned off for this run. Cancel it and build a new one.";
  }
  const subject = count === 1 ? "One payment on-chain goes" : `${count.toLocaleString()} payments on-chain go`;
  if (cancelled) return `${subject} to a different wallet or amount than the list your team saved, so the run was cancelled. No MUSD was paid out. Build a new run if these payments are still due.`;
  return `${subject} to a different wallet or amount than the list your team saved. Approving, funding and publishing are turned off for this run. Cancel it and build a new one.`;
}

/** Approval check rows: compare what is on-chain with the reviewed list, independent of the fingerprint. */
export function approvalCountsMatch(onchainCount: number | undefined, reviewedCount: number, onchainTotal: bigint | undefined, reviewedTotal: bigint): { countOk: boolean | undefined; totalOk: boolean | undefined } {
  return {
    countOk: onchainCount === undefined ? undefined : onchainCount === reviewedCount,
    totalOk: onchainTotal === undefined ? undefined : onchainTotal === reviewedTotal,
  };
}

/** Whether the build panel may offer "Continue": never while the run is blocked by a mismatch. */
export function canContinueBuild(run: Pick<PayrollRun, "status"> & { chainMismatch?: PayrollRun["chainMismatch"] | null }): boolean {
  return (run.status === "draft" || run.status === "onchain_draft") && !hasChainMismatch(run);
}

/** Runs that can still be cancelled whole, and who may do it (funded runs need an admin). */
export function canCancelRun(run: Pick<PayrollRun, "status">, roles: RolesMask): boolean {
  // Approved runs carry the approvers' sign-off, so only an admin may cancel them (PayrollEscrow.cancelRun).
  if (run.status === "funded" || run.status === "approved") return canAdmin(roles);
  return ["onchain_draft", "pending_approval"].includes(run.status) && canOperate(roles);
}

/** Single payments can only be cancelled while the run is still a draft on-chain. */
export function canCancelPayment(run: Pick<PayrollRun, "status">, item: Pick<PayrollItem, "paymentId" | "claimStatus">, roles: RolesMask): boolean {
  return run.status === "onchain_draft" && item.paymentId !== null && item.claimStatus === "allocated" && canOperate(roles);
}

/** Expiry is permissionless once the claim deadline has passed. */
export function canExpire(run: Pick<PayrollRun, "status">, deadlineMs: number | null, nowMs: number, connected: boolean): boolean {
  return connected && (run.status === "published" || run.status === "partially_claimed") && deadlineMs !== null && nowMs > deadlineMs;
}

/** Tab-separated list of every claim link (pastes cleanly into a spreadsheet). */
export function claimLinksTsv(run: Pick<PayrollRunDetail, "status" | "items">, origin: string): string {
  // One line per cell, and never let a spreadsheet read a name as a formula.
  const clean = (v: string) => v.replace(/[\t\r\n]+/g, " ").trim().replace(/^[=+\-@]/, "'$&");
  const lines = ["name\twallet\tamount_musd\tstatus\tclaim_link"];
  for (const i of [...run.items].sort((a, b) => a.index - b.index)) {
    if (!i.paymentId || i.claimStatus === "cancelled") continue;
    lines.push([clean(i.name), checksum(i.recipientAddress), weiToDecimalString(i.amount), itemStatus(i.claimStatus, run.status).label, `${origin}/claim/${i.paymentId}`].join("\t"));
  }
  return lines.join("\n") + "\n";
}

/** EIP-55 checksummed address for display; falls back to the input when it isn't an address. */
export function checksum(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}
