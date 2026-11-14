import { describe, expect, it } from "vitest";
import { canAdvance, maxReachableStep, newRow, rowsFromCsvText, summaryParts, toRunItems, validateRows, type WizardState } from "@/lib/client/wizard";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

function state(p: Partial<WizardState> = {}): WizardState {
  return { name: "Nov salary", category: "salary", frequency: "one_time", rows: [], excluded: new Set(), scheduledAt: "", claimWindowDays: 30, ...p };
}

describe("wizard gating", () => {
  it("type step needs a category and a name", () => {
    expect(canAdvance("type", state({ category: null })).ok).toBe(false);
    expect(canAdvance("type", state({ name: "  " })).ok).toBe(false);
    expect(canAdvance("type", state()).ok).toBe(true);
  });

  it("recipients step needs at least one row", () => {
    expect(canAdvance("recipients", state()).ok).toBe(false);
    expect(canAdvance("recipients", state({ rows: [newRow({ name: "a" })] })).ok).toBe(true);
  });

  it("blocks on invalid rows until they are fixed or explicitly excluded", () => {
    const good = newRow({ name: "Ana", walletAddress: A, amount: "100" });
    const bad = newRow({ name: "Bo", walletAddress: "0xnope", amount: "50" });
    const s = state({ rows: [good, bad] });
    const v = validateRows(s.rows, s.excluded);
    expect(v.blockingCount).toBe(1);
    expect(v.checks).toHaveLength(2); // nothing silently dropped
    expect(canAdvance("validate", s, v).ok).toBe(false);

    const ex = new Set([bad.key]);
    const v2 = validateRows(s.rows, ex);
    expect(v2.blockingCount).toBe(0);
    expect(v2.excludedCount).toBe(1);
    expect(canAdvance("validate", { ...s, excluded: ex }, v2).ok).toBe(true);
    expect(toRunItems(v2)).toHaveLength(1);
  });

  it("excluding one duplicate clears the other", () => {
    const r1 = newRow({ name: "Ana", walletAddress: A, amount: "100" });
    const r2 = newRow({ name: "Ana again", walletAddress: A, amount: "100" });
    const v = validateRows([r1, r2], new Set());
    expect(v.report.duplicateWallets).toBe(1);
    const v2 = validateRows([r1, r2], new Set([r2.key]));
    expect(v2.blockingCount).toBe(0);
  });

  it("rewrites row numbers in messages to the user's numbering", () => {
    const r0 = newRow({ name: "X", walletAddress: B, amount: "1" });
    const r1 = newRow({ name: "Ana", walletAddress: A, amount: "100" });
    const r2 = newRow({ name: "Ana again", walletAddress: A, amount: "100" });
    const v = validateRows([r0, r1, r2], new Set([r0.key]));
    const msg = v.checks[2].issues.find((i) => i.code === "duplicate_wallet")?.message;
    expect(msg).toMatch(/row 2\b/);
  });

  it("review step checks the claim window", () => {
    const rows = [newRow({ name: "Ana", walletAddress: A, amount: "100" })];
    const v = validateRows(rows, new Set());
    expect(canAdvance("review", state({ rows, claimWindowDays: 0 }), v).ok).toBe(false);
    expect(canAdvance("review", state({ rows, claimWindowDays: 400 }), v).ok).toBe(false);
    expect(canAdvance("review", state({ rows }), v).ok).toBe(true);
  });

  it("computes the furthest reachable step", () => {
    expect(maxReachableStep(state({ category: null }))).toBe(0);
    const rows = [newRow({ name: "Ana", walletAddress: A, amount: "100" })];
    expect(maxReachableStep(state({ rows }), validateRows(rows, new Set()))).toBe(3);
  });

  it("summarises counts and totals", () => {
    const rows = [
      newRow({ name: "Ana", walletAddress: A, amount: "1500" }),
      newRow({ name: "Bo", walletAddress: B, amount: "250.5" }),
      newRow({ name: "Cy", walletAddress: "0x123", amount: "1" }),
    ];
    const v = validateRows(rows, new Set());
    expect(summaryParts(v)).toEqual(["3 rows", "2 valid", "1 invalid wallet"]);
    expect(v.report.totalPayableWei).toBe((1750_500000000000000000n).toString());
  });

  it("imports CSV text and blocks files with missing columns", () => {
    expect(rowsFromCsvText(`name,wallet_address,amount\nAna,${A},10\n`).rows).toHaveLength(1);
    const bad = rowsFromCsvText("name,amount\nAna,10\n");
    expect(bad.rows).toHaveLength(0);
    expect(bad.fileErrors[0].code).toBe("missing_column");
  });
});
