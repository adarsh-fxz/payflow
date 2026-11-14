import "./helpers/env";
import { ESCROW, REGISTRY } from "./helpers/env";
import { describe, expect, it } from "vitest";
import { checkRecipientWallet, reservedRecipientMessage, validatePayrollCsv } from "@/lib/csv/validate";
import { createRunSchema, recipientInputSchema, recipientPatchSchema, upsertMemberSchema } from "@/lib/server/schemas";
import { contracts } from "@/lib/chain/config";

const OK = "0x52908400098527886E0F7030069857D2E4169EE7";
const item = (walletAddress: string) => ({ name: "X", walletAddress, amount: "1" });

describe("recipient wallets exclude the MUSD token, escrow and registry", () => {
  it("knows the deployed addresses (case-insensitive) and ignores undeployed zero addresses", () => {
    expect(contracts.escrow.toLowerCase()).toBe(ESCROW);
    expect(reservedRecipientMessage(ESCROW.toUpperCase().replace("0X", "0x"))).toMatch(/escrow/);
    expect(reservedRecipientMessage(REGISTRY)).toMatch(/registry/);
    expect(reservedRecipientMessage(contracts.musd.toLowerCase())).toMatch(/MUSD/);
    expect(reservedRecipientMessage("0x0000000000000000000000000000000000000000")).toBeNull();
    expect(checkRecipientWallet(OK).ok).toBe(true);
  });

  it("CSV validator rejects escrow and registry rows", () => {
    const r = validatePayrollCsv(`name,wallet_address,amount\nE,${ESCROW},1\nR,${REGISTRY},1\nOk,${OK},1\n`);
    expect(r.rows.map((x) => x.valid)).toEqual([false, false, true]);
    expect(r.rows[0]!.issues[0]).toMatchObject({ code: "invalid_wallet", message: expect.stringMatching(/escrow/) });
  });

  it("run and recipient API schemas refuse them", () => {
    for (const bad of [contracts.musd, ESCROW, REGISTRY]) {
      const run = createRunSchema.safeParse({ name: "Run", paymentCategory: "salary", frequency: "one_time", items: [item(OK), item(bad)] });
      expect(run.success).toBe(false);
      if (!run.success) expect(run.error.issues[0]!.path).toEqual(["items", 1, "walletAddress"]);
      expect(recipientInputSchema.safeParse({ name: "X", walletAddress: bad }).success).toBe(false);
      expect(recipientPatchSchema.safeParse({ walletAddress: bad }).success).toBe(false);
    }
    expect(createRunSchema.safeParse({ name: "Run", paymentCategory: "salary", frequency: "one_time", items: [item(OK)] }).success).toBe(true);
    expect(recipientInputSchema.safeParse({ name: "X", walletAddress: OK }).success).toBe(true);
  });

  it("member wallets keep the plain check (only payment recipients are restricted)", () => {
    expect(upsertMemberSchema.safeParse({ walletAddress: OK, roles: 2, txHash: "0x" + "ab".repeat(32) }).success).toBe(true);
  });
});
