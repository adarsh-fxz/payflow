"use client";

import { useReadContract } from "wagmi";
import { payrollEscrowAbi } from "@/lib/chain/abis";
import { CHAIN_RUN_STATUS, contracts, isDeployed, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { OUTAGE_POLL_MS } from "@/lib/client/api";

/** Poll every 20s while reads succeed; once retries have given up on a failing RPC, keep a slow
 *  poll so the "Can't reach Mezo" banner clears by itself when reads work again. */
const poll = (q: { state: { status: string } }) => (q.state.status === "error" ? OUTAGE_POLL_MS : 20_000);

/** Live on-chain view of one run: getRun + refundable + whether `me` already approved. */
export function useRunChain(chainRunId: string | null | undefined, me?: `0x${string}`) {
  const runId = chainRunId ? BigInt(chainRunId) : undefined;
  const enabled = isDeployed && runId !== undefined && runId > 0n;
  const run = useReadContract({
    address: contracts.escrow,
    abi: payrollEscrowAbi,
    functionName: "getRun",
    args: runId !== undefined ? [runId] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled, refetchInterval: poll },
  });
  const refundable = useReadContract({
    address: contracts.escrow,
    abi: payrollEscrowAbi,
    functionName: "refundable",
    args: runId !== undefined ? [runId] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled, refetchInterval: poll },
  });
  const approved = useReadContract({
    address: contracts.escrow,
    abi: payrollEscrowAbi,
    functionName: "hasApproved",
    args: runId !== undefined && me ? [runId, me] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled: enabled && Boolean(me), refetchInterval: (q) => (q.state.status === "error" ? OUTAGE_POLL_MS : false) },
  });
  const r = run.data;
  return {
    runId,
    run: r,
    status: r ? CHAIN_RUN_STATUS[Number(r.status)] : undefined,
    refundable: refundable.data,
    iApproved: approved.data,
    isLoading: run.isLoading,
    error: run.error ?? refundable.error,
    /** When the last successful chain read landed (ms), for "updated … ago". */
    updatedAt: run.dataUpdatedAt || undefined,
    refetch: () => Promise.all([run.refetch(), refundable.refetch(), approved.refetch()]),
  };
}
