import "./guard";
import type { Db } from "./db";
import { clientIp, fail } from "./http";

/**
 * Fixed-window counter in the rate_limits table (shared across instances).
 * Returns the count in the current window; throws rate_limited when over the limit.
 */
export async function rateLimit(db: Db, key: string, limit: number, windowSeconds: number): Promise<number> {
  const rows = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [key, windowSeconds],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (count > limit) throw fail("rate_limited", "Too many requests. Try again shortly.");
  return count;
}

export const LIMITS = {
  authNonce: { limit: 20, window: 60 },
  authVerify: { limit: 20, window: 60 },
  csv: { limit: 30, window: 60 },
  claimConfirm: { limit: 30, window: 60 },
  claimInfo: { limit: 120, window: 60 },
  txVerify: { limit: 60, window: 60 },
} as const;

export async function limitByIp(db: Db, req: Request, bucket: keyof typeof LIMITS): Promise<void> {
  const { limit, window } = LIMITS[bucket];
  await rateLimit(db, `${bucket}:${clientIp(req)}`, limit, window);
}

/** Separate counters per session wallet and per client IP: rotating either one alone does not help. */
export async function limitByWalletAndIp(db: Db, req: Request, bucket: keyof typeof LIMITS, wallet: string | null): Promise<void> {
  const { limit, window } = LIMITS[bucket];
  await rateLimit(db, `${bucket}:ip:${clientIp(req)}`, limit, window);
  if (wallet) await rateLimit(db, `${bucket}:wallet:${wallet.toLowerCase()}`, limit, window);
}

/** Counter per payment id (e.g. claim confirmations), so one payment cannot be hammered from many IPs. */
export async function limitByPayment(db: Db, bucket: keyof typeof LIMITS, paymentId: string): Promise<void> {
  const { limit, window } = LIMITS[bucket];
  await rateLimit(db, `${bucket}:payment:${paymentId}`, limit, window);
}
