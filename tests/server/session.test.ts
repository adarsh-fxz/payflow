import "./helpers/env";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createNonce, createSession, getSessionAddress, parseSignInMessage, verifySignIn, SESSION_COOKIE } from "@/lib/server/session";
import { rateLimit } from "@/lib/server/ratelimit";
import { freshDb } from "./helpers/db";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const DOMAIN = "payflow.test";

describe("wallet sign-in", () => {
  it("issues a message with domain, address, nonce, chain id and issued-at", async () => {
    const db = await freshDb();
    const n = await createNonce(db, account.address, DOMAIN);
    const f = parseSignInMessage(n.message)!;
    expect(f).toMatchObject({ domain: DOMAIN, address: account.address, chainId: 31611, nonce: n.nonce });
    expect(Date.parse(n.expiresAt) - Date.parse(f.issuedAt)).toBe(5 * 60 * 1000);
    await db.close();
  });

  it("verifies a personal_sign signature once, then creates a DB session", async () => {
    const db = await freshDb();
    const n = await createNonce(db, account.address, DOMAIN);
    const signature = await account.signMessage({ message: n.message });
    const addr = await verifySignIn(db, { address: account.address, message: n.message, signature, domain: DOMAIN });
    expect(addr).toBe(account.address.toLowerCase());
    await expect(verifySignIn(db, { address: account.address, message: n.message, signature, domain: DOMAIN })).rejects.toMatchObject({ code: "forbidden" });

    const { token } = await createSession(db, addr);
    const req = new Request("http://localhost/api/auth/session", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(await getSessionAddress(db, req)).toBe(addr);
    const stored = await db.query<{ id: string }>(`SELECT id FROM sessions`);
    expect(stored[0]!.id).not.toBe(token); // only a keyed hash of the token is stored
    expect(await getSessionAddress(db, new Request("http://localhost/", { headers: { cookie: `${SESSION_COOKIE}=${"0".repeat(64)}` } }))).toBeNull();
    await db.close();
  });

  it("rejects wrong signer, wrong domain, tampered message and expired nonce", async () => {
    const db = await freshDb();
    const n = await createNonce(db, account.address, DOMAIN);
    const badSig = await other.signMessage({ message: n.message });
    await expect(verifySignIn(db, { address: account.address, message: n.message, signature: badSig, domain: DOMAIN })).rejects.toMatchObject({ code: "forbidden" });
    const sig = await account.signMessage({ message: n.message });
    await expect(verifySignIn(db, { address: account.address, message: n.message, signature: sig, domain: "evil.test" })).rejects.toMatchObject({ code: "forbidden" });
    const tampered = n.message.replace("31611", "1");
    await expect(verifySignIn(db, { address: account.address, message: tampered, signature: sig, domain: DOMAIN })).rejects.toMatchObject({ code: "chain_mismatch" });
    const late = new Date(Date.now() + 6 * 60 * 1000);
    await expect(verifySignIn(db, { address: account.address, message: n.message, signature: sig, domain: DOMAIN, now: late })).rejects.toMatchObject({ code: "forbidden" });
    // Nonce issued for one address can't be used by another.
    const n2 = await createNonce(db, account.address, DOMAIN);
    const msg2 = n2.message.replace(account.address, other.address);
    const sig2 = await other.signMessage({ message: msg2 });
    await expect(verifySignIn(db, { address: other.address, message: msg2, signature: sig2, domain: DOMAIN })).rejects.toMatchObject({ code: "forbidden" });
    await db.close();
  });

  it("rate limits per key in a fixed window", async () => {
    const db = await freshDb();
    for (let i = 1; i <= 3; i++) expect(await rateLimit(db, "k", 3, 60)).toBe(i);
    await expect(rateLimit(db, "k", 3, 60)).rejects.toMatchObject({ code: "rate_limited" });
    await db.query(`UPDATE rate_limits SET window_start = now() - interval '2 minutes'`);
    expect(await rateLimit(db, "k", 3, 60)).toBe(1);
    await db.close();
  });
});
