/**
 * Wallet sign-in: DB nonce (5 min, single use) → personal_sign message → viem verifyMessage →
 * DB session (id = HMAC(SESSION_SECRET, token)) carried in an httpOnly, SameSite=Lax cookie.
 */
import "./guard";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { MEZO_TESTNET_ID } from "../chain/config";
import type { Db } from "./db";
import { ApiHttpError, fail } from "./http";
import { chainError, publicClient } from "./chain";

export const SESSION_COOKIE = "pf_session";
export const NONCE_TTL_SECONDS = 5 * 60;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const HEADER = "PayFlow sign-in";

const DEV_SECRET = "payflow-dev-only-session-secret-do-not-use-in-prod";

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET (>= 32 chars) is not configured");
  return DEV_SECRET;
}

export function hashToken(token: string): string {
  return createHmac("sha256", sessionSecret()).update(`session\n${token}`).digest("hex");
}

/**
 * Domain bound into the sign-in message.
 * Production (NODE_ENV=production): ONLY the host of NEXT_PUBLIC_APP_URL. Request headers such as
 * x-forwarded-host are attacker-influenced and are never used; a missing/invalid URL fails closed.
 * Development/test: NEXT_PUBLIC_APP_URL host if set, else the request Host.
 */
export function expectedDomain(req: Request): string {
  const app = process.env.NEXT_PUBLIC_APP_URL;
  let host: string | null = null;
  if (app) {
    try {
      host = new URL(app).host || null;
    } catch {
      host = null;
    }
  }
  if (process.env.NODE_ENV === "production") {
    if (!host) throw fail("internal", "Sign-in is not configured: set NEXT_PUBLIC_APP_URL to this site's public URL (e.g. https://payflow.example.com)");
    return host;
  }
  return host ?? req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
}

export interface SignInFields {
  domain: string;
  address: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}

export function buildSignInMessage(f: SignInFields): string {
  return [
    HEADER,
    "",
    "Sign this message to sign in to PayFlow. It does not send a transaction or cost gas.",
    "",
    `Domain: ${f.domain}`,
    `Address: ${f.address}`,
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
  ].join("\n");
}

export function parseSignInMessage(message: string): SignInFields | null {
  if (typeof message !== "string" || !message.startsWith(HEADER + "\n") || message.length > 2000) return null;
  const field = (name: string) => {
    const m = message.match(new RegExp(`^${name}: (.+)$`, "m"));
    return m ? m[1]!.trim() : null;
  };
  const domain = field("Domain");
  const address = field("Address");
  const nonce = field("Nonce");
  const issuedAt = field("Issued At");
  const chainId = Number(field("Chain ID"));
  if (!domain || !address || !nonce || !issuedAt || !Number.isInteger(chainId)) return null;
  return { domain, address, chainId, nonce, issuedAt };
}

export async function createNonce(db: Db, address: string, domain: string, now = new Date()) {
  if (!isAddress(address, { strict: false })) throw fail("invalid_input", "Invalid wallet address");
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + NONCE_TTL_SECONDS * 1000);
  await db.query(`INSERT INTO auth_nonces (nonce, address, expires_at) VALUES ($1, $2, $3)`, [nonce, address.toLowerCase(), expiresAt]);
  // Opportunistic cleanup of stale nonces.
  await db.query(`DELETE FROM auth_nonces WHERE expires_at < now() - interval '1 day'`);
  const message = buildSignInMessage({ domain, address: getAddress(address), chainId: MEZO_TESTNET_ID, nonce, issuedAt: now.toISOString() });
  return { nonce, message, expiresAt: expiresAt.toISOString() };
}

export type VerifyFn = (args: { address: Hex; message: string; signature: Hex }) => Promise<boolean>;

/**
 * Plain wallets: local ECDSA recovery, no RPC. Mezo Passport Bitcoin wallets sign as a Mezo smart
 * account, so when recovery doesn't match, the signature is checked on chain (ERC-1271, or ERC-6492
 * for an account that isn't deployed yet). An RPC outage there becomes 503 chain_unavailable.
 */
export const verifyWalletSignature: VerifyFn = async (args) => {
  if (await verifyMessage(args).catch(() => false)) return true;
  try {
    return await publicClient().verifyMessage(args);
  } catch (e) {
    const mapped = chainError(e);
    if (mapped !== e) throw mapped;
    return false;
  }
};

/** Verifies the signed message and consumes the nonce. Returns the lowercase address. */
export async function verifySignIn(
  db: Db,
  args: { address: string; message: string; signature: string; domain: string; now?: Date; verify?: VerifyFn },
): Promise<string> {
  const now = args.now ?? new Date();
  if (!isAddress(args.address, { strict: false })) throw fail("invalid_input", "Invalid wallet address");
  const address = getAddress(args.address);
  const f = parseSignInMessage(args.message);
  if (!f) throw fail("invalid_input", "Malformed sign-in message");
  if (f.domain !== args.domain) throw fail("forbidden", "Sign-in message was issued for a different domain");
  if (f.chainId !== MEZO_TESTNET_ID) throw fail("chain_mismatch", "Sign-in message is for a different chain");
  if (!isAddress(f.address, { strict: false }) || getAddress(f.address) !== address) throw fail("forbidden", "Message address does not match");
  const iat = Date.parse(f.issuedAt);
  if (!Number.isFinite(iat) || iat > now.getTime() + 60_000 || now.getTime() - iat > NONCE_TTL_SECONDS * 1000) {
    throw fail("forbidden", "Sign-in message expired. Request a new one");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(args.signature)) throw fail("invalid_input", "Invalid signature encoding");

  let valid = false;
  try {
    valid = await (args.verify ?? verifyWalletSignature)({ address, message: args.message, signature: args.signature as Hex });
  } catch (e) {
    if (e instanceof ApiHttpError && e.code === "chain_unavailable") throw e;
    valid = false;
  }
  if (!valid) throw fail("forbidden", "Signature does not match the wallet");

  // Single use: consume atomically; fails if expired, already used or bound to another address.
  const used = await db.query(
    `UPDATE auth_nonces SET used_at = $3 WHERE nonce = $1 AND address = $2 AND used_at IS NULL AND expires_at > $3 RETURNING nonce`,
    [f.nonce, address.toLowerCase(), now],
  );
  if (used.length === 0) throw fail("forbidden", "Sign-in nonce is invalid, expired or already used");
  return address.toLowerCase();
}

export async function createSession(db: Db, address: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await db.query(`INSERT INTO sessions (id, address, created_at, expires_at) VALUES ($1, $2, $3, $4)`, [hashToken(token), address.toLowerCase(), now, expiresAt]);
  return { token, expiresAt };
}

export async function destroySession(db: Db, token: string | undefined): Promise<void> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
  await db.query(`DELETE FROM sessions WHERE id = $1`, [hashToken(token)]);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function sessionToken(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE);
}

/** Returns the session wallet (lowercase) or null. */
export async function getSessionAddress(db: Db, req: Request): Promise<string | null> {
  const token = sessionToken(req);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const id = hashToken(token);
  const rows = await db.query<{ id: string; address: string }>(`SELECT id, address FROM sessions WHERE id = $1 AND expires_at > now()`, [id]);
  const row = rows[0];
  if (!row) return null;
  // Constant-time comparison for defense in depth (the lookup is by hash already).
  const a = Buffer.from(row.id);
  const b = Buffer.from(id);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row.address;
}

export async function requireSession(db: Db, req: Request): Promise<string> {
  const a = await getSessionAddress(db, req);
  if (!a) throw fail("unauthenticated", "Sign in with your wallet first");
  return a;
}

function secureCookie(req: Request): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return new URL(req.url).protocol === "https:";
}

export function sessionCookieHeader(req: Request, token: string, maxAgeSeconds: number): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (secureCookie(req)) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(req: Request): string {
  return sessionCookieHeader(req, "", 0);
}
