import type { ChainLog } from "@/lib/server/chain";
import { ESCROW, REGISTRY } from "./env";

let block = 1000n;
let idx = 0;

export function nextTx(): string {
  idx++;
  return ("0x" + idx.toString(16).padStart(64, "0")) as string;
}

export function log(contract: "escrow" | "registry", eventName: string, args: Record<string, unknown>, tx: string, logIndex: number, bn?: bigint): ChainLog {
  return {
    address: contract === "escrow" ? ESCROW : REGISTRY,
    eventName,
    args,
    transactionHash: tx,
    blockNumber: bn ?? block++,
    logIndex,
    blockTimestamp: new Date("2026-11-01T12:00:00Z"),
  };
}
