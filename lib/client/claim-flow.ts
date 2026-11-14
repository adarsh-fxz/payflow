import { CHAIN_RUN_STATUS } from "@/lib/chain/config";

/**
 * Pure pieces of the public claim page, kept here so the tests and the UI agree.
 */

/** Quiet retries for saving a confirmed claim to PayFlow (the worker also indexes it). */
export const BACKGROUND_SAVE_DELAYS_MS = [3_000, 10_000, 30_000, 60_000, 120_000] as const;

/**
 * Retry `save` after each delay until it succeeds, the delays run out or `cancelled()` turns true.
 * Never throws: a confirmed claim must never surface an error. Resolves true once saved.
 */
export async function saveInBackground(
  save: () => Promise<unknown>,
  opts: { delays?: readonly number[]; sleep?: (ms: number) => Promise<void>; cancelled?: () => boolean } = {},
): Promise<boolean> {
  const delays = opts.delays ?? BACKGROUND_SAVE_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const ms of delays) {
    await sleep(ms);
    if (opts.cancelled?.()) return false;
    try {
      await save();
      return true;
    } catch {
      // keep quiet; try again after the next delay
    }
  }
  return false;
}

/**
 * The run is still Published on-chain but its claim window has closed, so anyone (any connected
 * wallet, no PayFlow role) may call expireRun. `chainStatus` is the raw PayrollEscrow enum value.
 */
export function canCloseRunFromClaim(chainStatus: number | undefined, claimDeadlineSec: bigint | number | undefined, nowMs: number): boolean {
  if (chainStatus === undefined || claimDeadlineSec === undefined || nowMs <= 0) return false;
  if (CHAIN_RUN_STATUS[chainStatus] !== "published") return false;
  const deadline = Number(claimDeadlineSec);
  return deadline > 0 && nowMs > deadline * 1000;
}
