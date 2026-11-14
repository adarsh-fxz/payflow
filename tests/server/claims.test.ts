import "./helpers/env";
import { describe, expect, it } from "vitest";
import { claimStatusFromChain, parsePaymentId, recipientPaymentStatus } from "@/lib/server/claims";
import { reconcileRow } from "@/lib/server/dashboard";
import { runLiability, runRefundable, type RunRow } from "@/lib/server/dto";
import type { ChainRun } from "@/lib/server/chain";

const E = 10n ** 18n;
const chainRun = (o: Partial<ChainRun>): ChainRun => ({
  orgId: 1n, runRef: "0x00", paymentsHash: "0x00", creator: "0x", funder: "0x", status: 5, approvalsRequired: 1, approvals: 1,
  paymentCount: 2, claimedCount: 0, claimWindow: 3600, createdAt: 0n, fundedAt: 0n, publishedAt: 0n, claimDeadline: 2000n,
  allocated: 0n, funded: 0n, claimed: 0n, refunded: 0n, ...o,
});
const dbRun = (o: Partial<RunRow>): RunRow =>
  ({ id: "r", chain_run_id: "1", name: "n", status: "published", total_amount: "0", funded_amount: "0", claimed_amount: "0", refunded_amount: "0", ...o }) as RunRow;

describe("claim status (live chain)", () => {
  it("maps payment + run state", () => {
    expect(claimStatusFromChain({ status: 1 }, chainRun({ status: 5 }), 1000n)).toBe("allocated");
    expect(claimStatusFromChain({ status: 1 }, chainRun({ status: 5 }), 2001n)).toBe("expired");
    expect(claimStatusFromChain({ status: 2 }, chainRun({ status: 7 }), 5000n)).toBe("claimed");
    expect(claimStatusFromChain({ status: 3 }, chainRun({ status: 4 }), 0n)).toBe("cancelled");
    expect(claimStatusFromChain({ status: 1 }, chainRun({ status: 4 }), 0n)).toBe("not_published");
    expect(claimStatusFromChain({ status: 1 }, chainRun({ status: 6 }), 0n)).toBe("cancelled");
    expect(claimStatusFromChain({ status: 1 }, chainRun({ status: 7 }), 0n)).toBe("expired");
  });

  it("recipient dashboard status", () => {
    const now = new Date("2026-11-09T00:00:00Z");
    expect(recipientPaymentStatus({ run_status: "funded", claim_status: "allocated", claim_deadline: null }, now)).toBe("upcoming");
    expect(recipientPaymentStatus({ run_status: "published", claim_status: "allocated", claim_deadline: new Date("2026-12-01") }, now)).toBe("available");
    expect(recipientPaymentStatus({ run_status: "published", claim_status: "allocated", claim_deadline: new Date("2026-11-01") }, now)).toBe("expired");
    expect(recipientPaymentStatus({ run_status: "completed", claim_status: "claimed", claim_deadline: null }, now)).toBe("claimed");
    expect(recipientPaymentStatus({ run_status: "cancelled", claim_status: "allocated", claim_deadline: null }, now)).toBe("cancelled");
  });

  it("parsePaymentId rejects junk and ids without a run", () => {
    expect(parsePaymentId(((5n << 32n) | 3n).toString())).toBe((5n << 32n) | 3n);
    expect(() => parsePaymentId("12")).toThrow();
    expect(() => parsePaymentId("0x10")).toThrow();
    expect(() => parsePaymentId("-1")).toThrow();
  });
});

describe("claim reconciliation math", () => {
  it("liability / refundable mirror PayrollEscrow", () => {
    // Funded 150, 1 payment of 50 cancelled while funded → allocated 100, refundable 50.
    const funded = dbRun({ status: "funded", total_amount: (100n * E).toString(), funded_amount: (150n * E).toString() });
    expect(runLiability(funded)).toBe(100n * E);
    expect(runRefundable(funded)).toBe(50n * E);
    // Published, 60 claimed.
    const partial = dbRun({ status: "partially_claimed", total_amount: (100n * E).toString(), funded_amount: (150n * E).toString(), claimed_amount: (60n * E).toString() });
    expect(runLiability(partial)).toBe(40n * E);
    expect(runRefundable(partial)).toBe(50n * E);
    // Expired, 50 refunded earlier → remaining unclaimed 40 refundable, no liability.
    const expired = dbRun({ status: "expired", total_amount: (100n * E).toString(), funded_amount: (150n * E).toString(), claimed_amount: (60n * E).toString(), refunded_amount: (50n * E).toString() });
    expect(runLiability(expired)).toBe(0n);
    expect(runRefundable(expired)).toBe(40n * E);
  });

  it("reconcileRow matches identical DB/chain state and flags drift", () => {
    const db = dbRun({ status: "partially_claimed", total_amount: (100n * E).toString(), funded_amount: (100n * E).toString(), claimed_amount: (30n * E).toString() });
    const chain = chainRun({ status: 5, allocated: 100n * E, funded: 100n * E, claimed: 30n * E });
    const ok = reconcileRow(db, chain);
    expect(ok.matches).toBe(true);
    expect(ok.chain).toMatchObject({ outstandingWei: (70n * E).toString(), refundableWei: "0" });
    const drift = reconcileRow(db, chainRun({ status: 5, allocated: 100n * E, funded: 100n * E, claimed: 40n * E }));
    expect(drift.matches).toBe(false);
    const statusDrift = reconcileRow(dbRun({ ...db, status: "funded" }), chain);
    expect(statusDrift.matches).toBe(false);
    expect(reconcileRow(dbRun({ chain_run_id: null, status: "draft" }), null).matches).toBe(true);
  });

  it("reconcileRow: a cancelled run with matching money is not flagged, even if planned totals differ", () => {
    // DB kept the reviewed total (6) while the chain allocated something else (mismatch run) and then cancelled.
    const db = dbRun({ status: "cancelled", total_amount: (6n * E).toString() });
    const ok = reconcileRow(db, chainRun({ status: 6, allocated: 5n * E }));
    expect(ok.matches).toBe(true);
    expect(ok.chain).toMatchObject({ outstandingWei: "0", refundableWei: "0" });
    // Money that actually moved must still agree.
    const funded = dbRun({ status: "cancelled", total_amount: (6n * E).toString(), funded_amount: (6n * E).toString(), refunded_amount: (6n * E).toString() });
    expect(reconcileRow(funded, chainRun({ status: 6, allocated: 6n * E, funded: 6n * E, refunded: 6n * E })).matches).toBe(true);
    expect(reconcileRow(funded, chainRun({ status: 6, allocated: 6n * E, funded: 6n * E, refunded: 0n })).matches).toBe(false);
    // A non-cancelled run still compares the allocation.
    expect(reconcileRow(dbRun({ status: "pending_approval", total_amount: (6n * E).toString() }), chainRun({ status: 2, allocated: 5n * E })).matches).toBe(false);
  });
});
