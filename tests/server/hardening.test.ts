import "./helpers/env";
import { afterEach, describe, expect, it } from "vitest";
import { HttpRequestError, ContractFunctionExecutionError, ContractFunctionRevertedError } from "viem";
import { clientIp, handle, ApiHttpError } from "@/lib/server/http";
import { expectedDomain } from "@/lib/server/session";
import { createRunSchema, zText } from "@/lib/server/schemas";
import { assertSuccessfulCall, type ChainLog, type VerifiedReceipt } from "@/lib/server/chain";
import { verifyClaimReceipt } from "@/lib/server/claims";
import { isChainUnavailable } from "@/lib/server/chain-errors";
import { createOrg } from "@/lib/server/orgs";
import { createRun } from "@/lib/server/runs";
import { payrollEscrowAbi } from "@/lib/chain/abis";
import type { OrgRow } from "@/lib/server/authz";
import { ESCROW, REGISTRY } from "./helpers/env";
import { freshDb } from "./helpers/db";

const env = { ...process.env };
afterEach(() => {
  for (const k of ["VERCEL", "NEXT_PUBLIC_APP_URL"]) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  (process.env as Record<string, string>).NODE_ENV = env.NODE_ENV ?? "test";
});

const r = (headers: Record<string, string>) => new Request("http://payflow.test/api/x", { headers });

describe("client IP for rate limits trusts only the platform", () => {
  it("never uses the client-controlled first X-Forwarded-For entry", () => {
    delete process.env.VERCEL;
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6, 10.0.0.9" }))).toBe("10.0.0.9");
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6" }))).toBe("6.6.6.6"); // single hop = our proxy's view
    expect(clientIp(r({ "x-real-ip": "10.1.1.1" }))).toBe("10.1.1.1");
    expect(clientIp(r({}))).toBe("unknown");
  });
  it("on Vercel uses x-vercel-forwarded-for / x-real-ip", () => {
    process.env.VERCEL = "1";
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6, 7.7.7.7", "x-vercel-forwarded-for": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(r({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
  });
});

describe("sign-in domain", () => {
  it("in production comes only from NEXT_PUBLIC_APP_URL, never from x-forwarded-host", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.NEXT_PUBLIC_APP_URL = "https://payflow.example.com";
    expect(expectedDomain(r({ "x-forwarded-host": "evil.example", host: "evil.example" }))).toBe("payflow.example.com");
  });
  it("in production fails closed when NEXT_PUBLIC_APP_URL is missing or invalid", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => expectedDomain(r({ host: "evil.example" }))).toThrow(/NEXT_PUBLIC_APP_URL/);
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    expect(() => expectedDomain(r({ host: "evil.example" }))).toThrow(ApiHttpError);
  });
  it("in development falls back to the request host", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(expectedDomain(r({ host: "localhost:3000" }))).toBe("localhost:3000");
  });
});

describe("SAFE_TEXT matches the CSV validator", () => {
  it.each(["Ali\u200Bce", "evil\u202Etxt", "a\u2066b", "a\uFEFFx", "x\u0085y", "a\u0007"])("rejects %j", (v) => {
    expect(zText(100).safeParse(v).success).toBe(false);
  });
  it("accepts ordinary unicode", () => {
    expect(zText(100).safeParse("José Müller — 東京").success).toBe(true);
  });
});

const receipt = (o: Partial<VerifiedReceipt>): VerifiedReceipt => ({ hash: "0x" + "ab".repeat(32), status: "success", from: "0x" + "11".repeat(20), to: ESCROW, blockNumber: 1n, blockTimestamp: null, logs: [], ...o });
const claimedLog = (pid: bigint, address = ESCROW): ChainLog => ({ address, eventName: "PaymentClaimed", args: { paymentId: pid, runId: pid >> 32n, recipient: "0x" + "22".repeat(20), amount: 1n }, transactionHash: "0x" + "ab".repeat(32), blockNumber: 1n, logIndex: 0, blockTimestamp: null });

describe("receipt checks", () => {
  it("run/org txs must be successful calls TO the PayFlow contract", () => {
    expect(() => assertSuccessfulCall(receipt({}), ESCROW)).not.toThrow();
    expect(() => assertSuccessfulCall(receipt({ to: REGISTRY }), ESCROW)).toThrow(/not sent to the PayFlow contract/);
    expect(() => assertSuccessfulCall(receipt({ to: "0x" + "99".repeat(20) }), REGISTRY)).toThrow(/not sent to the PayFlow contract/);
    expect(() => assertSuccessfulCall(receipt({ to: null }), ESCROW)).toThrow(/not sent/);
    expect(() => assertSuccessfulCall(receipt({ status: "reverted" }), ESCROW)).toThrow(/reverted/);
  });

  it("claims accept smart-wallet txs (to ≠ escrow) only with the escrow's PaymentClaimed log for that payment", () => {
    const pid = (5n << 32n) | 1n;
    const smartWallet = "0x" + "5a".repeat(20);
    expect(verifyClaimReceipt(receipt({ to: smartWallet, logs: [claimedLog(pid)] }), pid).eventName).toBe("PaymentClaimed");
    expect(() => verifyClaimReceipt(receipt({ to: smartWallet, logs: [] }), pid)).toThrow(/did not claim/);
    expect(() => verifyClaimReceipt(receipt({ to: smartWallet, logs: [claimedLog(pid, smartWallet)] }), pid)).toThrow(/did not claim/);
    expect(() => verifyClaimReceipt(receipt({ logs: [claimedLog(pid + 1n)] }), pid)).toThrow(/did not claim/);
    expect(() => verifyClaimReceipt(receipt({ status: "reverted", logs: [claimedLog(pid)] }), pid)).toThrow(/reverted/);
  });
});

describe("RPC outage classification", () => {
  it("transport failures are chain_unavailable (503), contract reverts are not", async () => {
    const http = new HttpRequestError({ url: "https://rpc.test.mezo.org", details: "fetch failed" });
    expect(isChainUnavailable(http)).toBe(true);
    expect(isChainUnavailable(new TypeError("fetch failed"))).toBe(true);
    const revert = new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: payrollEscrowAbi, functionName: "getRun", message: "execution reverted" }), { abi: payrollEscrowAbi, functionName: "getRun", args: [1n] });
    expect(isChainUnavailable(revert)).toBe(false);
    expect(isChainUnavailable(new Error("boom"))).toBe(false);
    const res = await handle(async () => {
      throw http;
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("chain_unavailable");
  });
});

describe("scale: batched item inserts", () => {
  it("creates a 5,000-item run in a few seconds on PGlite", async () => {
    const db = await freshDb();
    const org = await createOrg(db, "0x00000000000000000000000000000000000000a1", { name: "Big Co", description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 30 });
    const row = (await db.query<OrgRow>(`SELECT * FROM organizations WHERE id = $1`, [org.id]))[0]!;
    const input = createRunSchema.parse({
      name: "Big", paymentCategory: "salary", frequency: "one_time",
      items: Array.from({ length: 5000 }, (_, i) => ({ name: `R${i}`, walletAddress: `0x${(0x100000 + i).toString(16).padStart(40, "0")}`, amount: "1.5" })),
    });
    const t0 = performance.now();
    const run = await createRun(db, "0x00000000000000000000000000000000000000a1", row, input);
    const ms = performance.now() - t0;
    expect(run.items).toHaveLength(5000);
    expect(run.totalAmount).toBe((7500n * 10n ** 18n).toString());
    expect(run.items[4999]!.index).toBe(4999);
    expect(ms).toBeLessThan(5_000);
    await db.close();
  });
});
