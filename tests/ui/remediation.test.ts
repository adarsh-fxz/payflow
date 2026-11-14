import { describe, expect, it } from "vitest";
import { BaseError, encodeErrorResult } from "viem";
import type { ChainMismatch, PayrollItem, PayrollRunDetail } from "@/lib/api-types";
import { payrollEscrowAbi } from "@/lib/chain/abis";
import { describeTxError, isRpcUnreachable, OZ_TOKEN_ERRORS } from "@/lib/client/errors";
import { rowsFromCsvText, validateRows } from "@/lib/client/wizard";
import { claimsLabel, itemStatus, timelineSteps } from "@/lib/client/status";
import { canCancelPayment, canCancelRun, canExpire, checksum, claimLinksTsv, hasChainMismatch, stepBlock } from "@/lib/client/run-gates";
import { canManageMember, canReturn } from "@/lib/client/roles";
import { retryDelay, shouldRetry, ApiClientError, isChainUnavailable } from "@/lib/client/api";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const E18 = 10n ** 18n;

describe("wizard keeps invalid emails", () => {
  it("flags a bad email instead of dropping it", () => {
    const csv = `name,email,wallet_address,amount,description,department\nAna,not-an-email,${A},10,Nov,\nBo,bo@example.com,${B},5,Nov,\n`;
    const { rows } = rowsFromCsvText(csv);
    expect(rows[0].email).toBe("not-an-email");
    expect(rows[1].email).toBe("bo@example.com");
    const v = validateRows(rows, new Set());
    expect(v.checks[0].valid).toBe(false);
    expect(v.checks[0].issues.some((i) => i.code === "invalid_email")).toBe(true);
    expect(v.checks[1].valid).toBe(true);
    expect(v.blockingCount).toBe(1);
  });

  it("finds the email column whatever its header case or position", () => {
    const csv = `Wallet Address,Name,Amount,E-mail,EMAIL\n${A},Ana,1,,bad@\n`;
    const { rows } = rowsFromCsvText(csv);
    expect(rows[0]?.email).toBe("bad@");
  });

  it("leaves rows without an email column empty", () => {
    const { rows } = rowsFromCsvText(`name,wallet_address,amount\nAna,${A},1\n`);
    expect(rows[0].email).toBe("");
  });
});

describe("error decoding names the cause", () => {
  const encEscrow = (errorName: string, args?: readonly unknown[]) => encodeErrorResult({ abi: payrollEscrowAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);

  it("ERC20InsufficientBalance says how much MUSD there is and is needed", () => {
    const data = encodeErrorResult({ abi: OZ_TOKEN_ERRORS, errorName: "ERC20InsufficientBalance", args: [A, 80n * E18, 115n * E18] } as Parameters<typeof encodeErrorResult>[0]);
    const d = describeTxError(new Error(`execution reverted ${data}`));
    expect(d.title).toBe("Not enough MUSD");
    expect(d.kind).toBe("funds");
    expect(d.message).toMatch(/80 MUSD/);
    expect(d.message).toMatch(/115 MUSD/);
  });

  it("the classic revert string means MUSD, not gas", () => {
    const d = describeTxError(new BaseError("Execution reverted with reason: ERC20: transfer amount exceeds balance."));
    expect(d.title).toBe("Not enough MUSD");
    expect(describeTxError({ data: { errorName: "Error", args: ["ERC20: transfer amount exceeds allowance"] } }).title).toBe("MUSD allowance too low");
  });

  it("native gas shortfall still reads as BTC for fees", () => {
    expect(describeTxError(new Error("insufficient funds for gas * price + value")).title).toMatch(/BTC/);
  });

  it("ApprovalsRevoked explains the count and what to do", () => {
    const d = describeTxError({ data: { errorName: "ApprovalsRevoked", args: [1n, 1, 2] } });
    expect(d.title).toBe("Approvals no longer valid");
    expect(d.message).toMatch(/Only 1 of the 2 approvals/);
    expect(d.message).toMatch(/approver role again, or return the run to draft/);
  });

  it("decodes ApprovalsRevoked from raw revert data", () => {
    const d = describeTxError(new Error(`reverted ${encEscrow("ApprovalsRevoked", [3n, 0, 1])}`));
    expect(d.errorName).toBe("ApprovalsRevoked");
  });

  it("NotAuthorized names the role", () => {
    expect(describeTxError({ data: { errorName: "NotAuthorized", args: [1n, A, 1] } }).message).toMatch(/admin role/);
    expect(describeTxError({ data: { errorName: "NotAuthorized", args: [1n, A, 2] } }).message).toMatch(/approver role/);
    expect(describeTxError({ data: { errorName: "NotAuthorized", args: [1n, A, 5] } }).message).toMatch(/operator or admin role/);
  });

  it("InvalidStatus says what state the run is in", () => {
    expect(describeTxError({ data: { errorName: "InvalidStatus", args: [1n, 5] } }).message).toMatch(/published/);
    expect(describeTxError({ data: { errorName: "InvalidStatus", args: [1n, 6] } }).message).toMatch(/cancelled/);
  });

  it("ClaimWindowClosed gives the date", () => {
    expect(describeTxError({ data: { errorName: "ClaimWindowClosed", args: [1n, 1_700_000_000n] } }).message).toMatch(/closed on .*2023/);
  });
});

describe("status wording", () => {
  it("never calls a payment Unclaimed before the run is published", () => {
    for (const run of ["onchain_draft", "pending_approval", "approved"] as const) expect(itemStatus("allocated", run).label).toBe("Waiting for funding");
    expect(itemStatus("allocated", "funded").label).toBe("Not published yet");
    expect(itemStatus("allocated", "published").label).toBe("Unclaimed");
    expect(itemStatus("allocated", "partially_claimed").label).toBe("Unclaimed");
    expect(itemStatus("allocated", "cancelled").label).toBe("Cancelled");
    expect(itemStatus("allocated", "expired").label).toBe("Expired");
    expect(itemStatus("claimed", "partially_claimed").label).toBe("Claimed");
    expect(itemStatus("pending", "draft").label).toBe("Not on-chain yet");
  });

  it("the timeline's current step is where the run is, not the next one", () => {
    const partly = timelineSteps("partially_claimed");
    expect(partly.find((s) => s.state === "current")?.label).toBe("Open for claims");
    expect(partly.find((s) => s.key === "done")?.state).toBe("todo");
    expect(timelineSteps("approved").find((s) => s.state === "current")?.label).toBe("Approved");
    expect(timelineSteps("completed").every((s) => s.state === "done")).toBe(true);
    expect(timelineSteps("expired").some((s) => s.state === "current")).toBe(false);
    expect(timelineSteps("draft").filter((s) => s.state === "current")).toHaveLength(1);
  });

  it("pluralises claims", () => {
    expect(claimsLabel(1)).toBe("1 claim");
    expect(claimsLabel(0)).toBe("0 claims");
    expect(claimsLabel(2)).toBe("2 claims");
  });
});

describe("chain mismatch and approval gating", () => {
  const mismatch: ChainMismatch = { index: 0, name: "Ana", reviewedRecipient: A, reviewedAmount: String(10n * E18), chainRecipient: B, chainAmount: String(10n * E18), txHash: null };
  const base = { status: "pending_approval" as const, validApprovals: 0, approvalsRequired: 1, chainMismatch: [] as ChainMismatch[] };

  it("blocks approve, fund and publish when the chain differs from the review", () => {
    const run = { ...base, chainMismatch: [mismatch] };
    expect(hasChainMismatch(run)).toBe(true);
    for (const s of ["approve", "fund", "publish"] as const) expect(stepBlock(run, s)).toMatch(/differs/);
  });

  it("treats a missing field as no mismatch (older API)", () => {
    expect(hasChainMismatch({ chainMismatch: undefined })).toBe(false);
    expect(stepBlock({ ...base, chainMismatch: undefined }, "approve")).toBeNull();
  });

  it("blocks funding when approvals were revoked", () => {
    expect(stepBlock({ ...base, status: "approved", validApprovals: 1, approvalsRequired: 2 }, "fund")).toMatch(/only 1 of 2/);
    expect(stepBlock({ ...base, status: "approved", validApprovals: 2, approvalsRequired: 2 }, "fund")).toBeNull();
    expect(stepBlock({ ...base, status: "approved", validApprovals: null, approvalsRequired: null }, "fund")).toBeNull();
  });

  it("single payments can only be cancelled in an on-chain draft", () => {
    const item = { paymentId: "1", claimStatus: "allocated" as const };
    expect(canCancelPayment({ status: "onchain_draft" }, item, 4)).toBe(true);
    expect(canCancelPayment({ status: "funded" }, item, 7)).toBe(false);
    expect(canCancelPayment({ status: "approved" }, item, 7)).toBe(false);
  });

  it("funded runs are cancelled whole, by an admin", () => {
    expect(canCancelRun({ status: "funded" }, 4)).toBe(false);
    expect(canCancelRun({ status: "funded" }, 1)).toBe(true);
    expect(canCancelRun({ status: "approved" }, 4)).toBe(false); // operator can't drop approvers' sign-off
    expect(canCancelRun({ status: "approved" }, 1)).toBe(true);
    expect(canCancelRun({ status: "pending_approval" }, 4)).toBe(true);
    expect(canCancelRun({ status: "published" }, 7)).toBe(false);
  });

  it("only an admin can send an approved run back to draft", () => {
    expect(canReturn(4, "pending_approval")).toBe(true);
    expect(canReturn(2, "pending_approval")).toBe(true);
    expect(canReturn(4, "approved")).toBe(false);
    expect(canReturn(2, "approved")).toBe(false);
    expect(canReturn(1, "approved")).toBe(true);
  });

  it("anyone connected may expire after the deadline", () => {
    expect(canExpire({ status: "published" }, 1000, 2000, true)).toBe(true);
    expect(canExpire({ status: "published" }, 3000, 2000, true)).toBe(false);
    expect(canExpire({ status: "published" }, 1000, 2000, false)).toBe(false);
    expect(canExpire({ status: "funded" }, 1000, 2000, true)).toBe(false);
  });
});

describe("claim link list", () => {
  const item = (p: Partial<PayrollItem>): PayrollItem => ({ id: "x", index: 0, recipientId: null, name: "Ana", email: null, department: null, recipientAddress: A, amount: String(15n * E18 / 10n), description: "", paymentId: "4294967296", claimStatus: "allocated", transactionHash: null, claimedAt: null, ...p });
  it("lists name, checksummed wallet, amount, status and link; skips cancelled and off-chain rows", () => {
    const run = { status: "published", items: [item({}), item({ index: 1, name: "=HYPERLINK(1)", paymentId: "4294967297", recipientAddress: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }), item({ index: 2, paymentId: null }), item({ index: 3, claimStatus: "cancelled", paymentId: "4294967299" })] } as unknown as PayrollRunDetail;
    const lines = claimLinksTsv(run, "https://pay.example").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(`Ana\t${checksum(A)}\t1.5\tUnclaimed\thttps://pay.example/claim/4294967296`);
    expect(lines[2].startsWith("'=HYPERLINK")).toBe(true);
    expect(lines[2]).toContain("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });
});

describe("retry policy", () => {
  it("backs off exponentially and gives up", () => {
    expect([0, 1, 2].map(retryDelay)).toEqual([1000, 2000, 4000]);
    expect(shouldRetry(0, new Error("x"))).toBe(true);
    expect(shouldRetry(3, new Error("x"))).toBe(false);
    expect(shouldRetry(0, new ApiClientError(404, "not_found", "no"))).toBe(false);
  });
  it("recognises chain_unavailable", () => {
    expect(isChainUnavailable(new ApiClientError(503, "chain_unavailable", "down"))).toBe(true);
    expect(isChainUnavailable(new ApiClientError(500, "internal", "x"))).toBe(false);
  });
});

describe("member management follows the registry rules", () => {
  it("owner manages anyone; admins only pure operators", () => {
    expect(canManageMember({ isOwner: true, admin: true, memberRoles: 3 })).toBe(true);
    expect(canManageMember({ isOwner: false, admin: true, memberRoles: 4 })).toBe(true);
    expect(canManageMember({ isOwner: false, admin: true, memberRoles: 6 })).toBe(false);
    expect(canManageMember({ isOwner: false, admin: true, memberRoles: 2 })).toBe(false);
    expect(canManageMember({ isOwner: false, admin: false, memberRoles: 4 })).toBe(false);
  });
});

describe("rpc reachability", () => {
  it("separates network failures from contract reverts", () => {
    expect(isRpcUnreachable(new Error("HTTP request failed. fetch failed"))).toBe(true);
    expect(isRpcUnreachable(new Error("The request took too long to respond."))).toBe(true);
    expect(isRpcUnreachable({ data: { errorName: "RunNotFound", args: [1n] } })).toBe(false);
    expect(isRpcUnreachable(null)).toBe(false);
  });
});
