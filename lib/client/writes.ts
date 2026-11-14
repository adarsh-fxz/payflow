import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hash, Hex, TransactionReceipt } from "viem";
import type { Config } from "wagmi";
import { getAccount, simulateContract, waitForTransactionReceipt, writeContract } from "@wagmi/core";
import { erc20Abi, organizationRegistryAbi, payrollEscrowAbi } from "@/lib/chain/abis";
import { contracts, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { assertChain } from "./guard";

/** A single contract write described as data, so it can be gas-estimated, previewed and tested. */
export interface WriteSpec {
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

type Mutating = "nonpayable" | "payable";
function spec<const abi extends Abi, fn extends ContractFunctionName<abi, Mutating>>(
  label: string,
  address: Address,
  abi: abi,
  functionName: fn,
  args: ContractFunctionArgs<abi, Mutating, fn>,
): WriteSpec {
  return { label, address, abi: abi as Abi, functionName, args: args as readonly unknown[] };
}

const E = () => contracts.escrow;
const R = () => contracts.registry;

export const build = {
  createOrganization: (metadataHash: Hex) =>
    spec("Register organization", R(), organizationRegistryAbi, "createOrganization", [metadataHash]),
  setMemberRoles: (orgId: bigint, member: Address, roles: number) =>
    spec(roles === 0 ? "Remove member" : "Set member roles", R(), organizationRegistryAbi, "setMemberRoles", [orgId, member, roles]),
  setMetadata: (orgId: bigint, metadataHash: Hex) =>
    spec("Update organization fingerprint", R(), organizationRegistryAbi, "setMetadata", [orgId, metadataHash]),
  setApprovalsRequired: (orgId: bigint, n: number) =>
    spec("Set approvals required", R(), organizationRegistryAbi, "setApprovalsRequired", [orgId, n]),

  createRun: (orgId: bigint, runRef: Hex, claimWindow: number) =>
    spec("Create run on-chain", E(), payrollEscrowAbi, "createRun", [orgId, runRef, claimWindow]),
  addPayments: (runId: bigint, expectedIndex: number, recipients: Address[], amounts: bigint[], label = "Add payments") =>
    spec(label, E(), payrollEscrowAbi, "addPayments", [runId, expectedIndex, recipients, amounts]),
  submitForApproval: (runId: bigint) => spec("Submit for approval", E(), payrollEscrowAbi, "submitForApproval", [runId]),
  returnToDraft: (runId: bigint) => spec("Return to draft", E(), payrollEscrowAbi, "returnToDraft", [runId]),
  approve: (runId: bigint, hash: Hex) => spec("Approve run", E(), payrollEscrowAbi, "approve", [runId, hash]),
  approveMusd: (amount: bigint) => spec("Allow MUSD transfer", contracts.musd, erc20Abi, "approve", [contracts.escrow, amount]),
  fund: (runId: bigint) => spec("Fund run", E(), payrollEscrowAbi, "fund", [runId]),
  fundWithPermit: (runId: bigint, deadline: bigint, v: number, r: Hex, s: Hex) =>
    spec("Fund run", E(), payrollEscrowAbi, "fundWithPermit", [runId, deadline, v, r, s]),
  publish: (runId: bigint) => spec("Publish run", E(), payrollEscrowAbi, "publish", [runId]),
  cancelRun: (runId: bigint) => spec("Cancel run", E(), payrollEscrowAbi, "cancelRun", [runId]),
  cancelPayment: (paymentId: bigint) => spec("Cancel payment", E(), payrollEscrowAbi, "cancelPayment", [paymentId]),
  expireRun: (runId: bigint) => spec("Close claim window", E(), payrollEscrowAbi, "expireRun", [runId]),
  refund: (runId: bigint) => spec("Refund unclaimed MUSD", E(), payrollEscrowAbi, "refund", [runId]),
  claim: (paymentId: bigint) => spec("Claim payment", E(), payrollEscrowAbi, "claim", [paymentId]),
  claimMany: (ids: bigint[]) => spec("Claim payments", E(), payrollEscrowAbi, "claimMany", [ids]),
};

export interface WriteResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

/** Checks the chain, simulates (so reverts surface before the wallet prompt), sends, waits. */
export async function executeWrite(config: Config, s: WriteSpec, onSubmitted?: (hash: Hash) => void): Promise<WriteResult> {
  const conn = getAccount(config);
  if (!conn.address) throw new Error("Wallet not connected");
  assertChain(conn.chainId, MEZO_TESTNET_ID);
  const { request } = await simulateContract(config, {
    address: s.address,
    abi: s.abi,
    functionName: s.functionName,
    args: s.args,
    account: conn.address,
    chainId: MEZO_TESTNET_ID,
  } as Parameters<typeof simulateContract>[1]);
  assertChain(getAccount(config).chainId, MEZO_TESTNET_ID);
  const hash = await writeContract(config, request as Parameters<typeof writeContract>[1]);
  onSubmitted?.(hash);
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: MEZO_TESTNET_ID, timeout: 180_000 });
  if (receipt.status !== "success") {
    const err = new Error("The transaction was reverted on-chain.") as Error & { hash: Hash };
    err.hash = hash;
    throw err;
  }
  return { hash, receipt };
}
