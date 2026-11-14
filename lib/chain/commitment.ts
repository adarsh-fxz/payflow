// FROZEN. Off-chain recomputation of PayrollEscrow.Run.paymentsHash.
// Lets the approver confirm the on-chain run equals the reviewed manifest before signing approve().
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { paymentIdOf } from "./config";

export type CommitmentOp =
  | { kind: "add"; index: number; recipient: Address; amount: bigint }
  | { kind: "cancel"; index: number };

/** Seed of the commitment. The claim window is part of it, so approvers sign the window too. */
export function initialPaymentsHash(chainId: number, escrow: Address, runId: bigint, claimWindowSeconds: number): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint32" }], [BigInt(chainId), escrow, runId, claimWindowSeconds]),
  );
}

/** Apply ops in the exact order they happened on-chain (adds by index, then any draft cancels). */
export function paymentsHash(chainId: number, escrow: Address, runId: bigint, claimWindowSeconds: number, ops: CommitmentOp[]): Hex {
  let h = initialPaymentsHash(chainId, escrow, runId, claimWindowSeconds);
  const types = [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint128" }] as const;
  for (const op of ops) {
    const pid = paymentIdOf(runId, op.index);
    h = op.kind === "add"
      ? keccak256(encodeAbiParameters(types, [h, pid, op.recipient, op.amount]))
      : keccak256(encodeAbiParameters(types, [h, pid, "0x0000000000000000000000000000000000000000", 0n]));
  }
  return h;
}
