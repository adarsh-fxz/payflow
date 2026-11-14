import { describe, expect, it, vi } from "vitest";
import { canCloseRunFromClaim, saveInBackground } from "@/lib/client/claim-flow";
import { ApiClientError, OUTAGE_POLL_MS, outagePoll } from "@/lib/client/api";
import { approvalCountsMatch, approvalsShortfall, canContinueBuild, mismatchSummary } from "@/lib/client/run-gates";
import type { ChainMismatch } from "@/lib/api-types";

const noSleep = () => Promise.resolve();

describe("claim success: saving to PayFlow retries quietly", () => {
  it("retries after failures and resolves true once saved, never throwing", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Sign in with your wallet first")).mockRejectedValueOnce(new Error("503")).mockResolvedValue({});
    const sleeps: number[] = [];
    await expect(saveInBackground(save, { delays: [1, 2, 3, 4], sleep: async (ms) => void sleeps.push(ms) })).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1, 2, 3]);
  });

  it("gives up silently after the last delay", async () => {
    const save = vi.fn().mockRejectedValue(new Error("down"));
    await expect(saveInBackground(save, { delays: [1, 2], sleep: noSleep })).resolves.toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("stops when the page is gone", async () => {
    const save = vi.fn().mockRejectedValue(new Error("down"));
    let gone = false;
    const p = saveInBackground(save, { delays: [1, 2, 3], sleep: async () => void (gone = save.mock.calls.length >= 1), cancelled: () => gone });
    await expect(p).resolves.toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("claim page: closing a run whose window ended", () => {
  const PUBLISHED = 5, EXPIRED = 7, FUNDED = 4;
  const deadline = 1_700_000_000n;
  const after = Number(deadline) * 1000 + 1;
  it("any wallet may close a Published run after its deadline", () => {
    expect(canCloseRunFromClaim(PUBLISHED, deadline, after)).toBe(true);
  });
  it("not before the deadline, not once expired, not for other states, not without data", () => {
    expect(canCloseRunFromClaim(PUBLISHED, deadline, Number(deadline) * 1000)).toBe(false);
    expect(canCloseRunFromClaim(EXPIRED, deadline, after)).toBe(false);
    expect(canCloseRunFromClaim(FUNDED, deadline, after)).toBe(false);
    expect(canCloseRunFromClaim(undefined, deadline, after)).toBe(false);
    expect(canCloseRunFromClaim(PUBLISHED, 0n, after)).toBe(false);
    expect(canCloseRunFromClaim(PUBLISHED, deadline, 0)).toBe(false);
  });
});

describe("RPC outage: slow poll keeps going until calls succeed", () => {
  it("polls every 20-30s only while the last error was chain_unavailable", () => {
    expect(OUTAGE_POLL_MS).toBeGreaterThanOrEqual(20_000);
    expect(OUTAGE_POLL_MS).toBeLessThanOrEqual(30_000);
    expect(outagePoll(new ApiClientError(503, "chain_unavailable", "down"))).toBe(OUTAGE_POLL_MS);
    expect(outagePoll(null)).toBe(false);
    expect(outagePoll(null, 20_000)).toBe(20_000);
    expect(outagePoll(new ApiClientError(404, "not_found", "x"))).toBe(false);
  });
});

describe("mismatch run copy and gating", () => {
  const m = [{ index: 1 }] as ChainMismatch[];
  it("no Continue while a mismatch blocks the run", () => {
    expect(canContinueBuild({ status: "onchain_draft", chainMismatch: m })).toBe(false);
    expect(canContinueBuild({ status: "onchain_draft", chainMismatch: [] })).toBe(true);
    expect(canContinueBuild({ status: "draft", chainMismatch: [] })).toBe(true);
    expect(canContinueBuild({ status: "pending_approval", chainMismatch: [] })).toBe(false);
  });
  it("grammar: one payment goes, many go; cancelled runs get no cancel instruction", () => {
    expect(mismatchSummary(1, false)).toMatch(/^One payment on-chain goes to/);
    expect(mismatchSummary(3, false)).toMatch(/^3 payments on-chain go to/);
    expect(mismatchSummary(1, false)).toMatch(/Cancel it/);
    expect(mismatchSummary(1, true)).not.toMatch(/Cancel it|Ask an/);
    expect(mismatchSummary(1, true)).toMatch(/was cancelled/);
  });
  it("count/total say 'differs' only when they actually differ", () => {
    expect(approvalCountsMatch(3, 3, 6n, 6n)).toEqual({ countOk: true, totalOk: true });
    expect(approvalCountsMatch(3, 2, 6n, 5n)).toEqual({ countOk: false, totalOk: false });
    expect(approvalCountsMatch(undefined, 2, undefined, 5n)).toEqual({ countOk: undefined, totalOk: undefined });
  });
  it("approval shortfall says re-granting the role is enough", () => {
    expect(approvalsShortfall(1, 2)).toMatch(/approver role again, or return the run to draft and collect new approvals/);
  });
});
