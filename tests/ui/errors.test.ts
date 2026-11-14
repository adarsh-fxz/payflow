import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { payrollEscrowAbi } from "@/lib/chain/abis";
import { decodeRevertData, describeTxError, humanizeErrorName } from "@/lib/client/errors";

const enc = (errorName: string, args?: readonly unknown[]) =>
  encodeErrorResult({ abi: payrollEscrowAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]);

describe("tx error decoding", () => {
  it("decodes raw revert data from the escrow ABI", () => {
    const data = enc("NotRecipient", [5n, "0x0000000000000000000000000000000000000001"]);
    expect(decodeRevertData(data)?.errorName).toBe("NotRecipient");
  });

  it("explains a wrong-wallet claim in plain words", () => {
    const err = { data: { errorName: "NotRecipient", args: [1n, "0x01"] } };
    const d = describeTxError(err);
    expect(d.kind).toBe("revert");
    expect(d.message).toMatch(/Only the wallet this payment was sent to/);
  });

  it("includes the run state for InvalidStatus", () => {
    const d = describeTxError({ data: { errorName: "InvalidStatus", args: [1n, 2] } });
    expect(d.message).toMatch(/waiting for approval/);
  });

  it("formats the deadline for ClaimWindowClosed", () => {
    const d = describeTxError({ data: { errorName: "ClaimWindowClosed", args: [1n, 1_700_000_000n] } });
    expect(d.message).toMatch(/closed on/);
  });

  it("decodes a viem ContractFunctionRevertedError via the cause chain", () => {
    const data = enc("HashMismatch", ["0x" + "11".repeat(32), "0x" + "22".repeat(32)]);
    const inner = new ContractFunctionRevertedError({ abi: payrollEscrowAbi, data, functionName: "approve" });
    const outer = new BaseError("Execution reverted", { cause: inner });
    const d = describeTxError(outer);
    expect(d.errorName).toBe("HashMismatch");
    expect(d.message).toMatch(/changed since you reviewed/);
  });

  it("finds a selector inside an RPC message", () => {
    const data = enc("EmptyRun");
    const d = describeTxError(new Error(`execution reverted: custom error ${data}`));
    expect(d.errorName).toBe("EmptyRun");
  });

  it("recognises a wallet rejection", () => {
    expect(describeTxError({ code: 4001, message: "User rejected the request." }).kind).toBe("rejected");
  });

  it("recognises missing gas funds", () => {
    expect(describeTxError(new Error("insufficient funds for gas * price + value")).kind).toBe("funds");
  });

  it("humanizes unknown names", () => {
    expect(humanizeErrorName("SomethingOddHappened")).toBe("Something odd happened.");
  });
});
