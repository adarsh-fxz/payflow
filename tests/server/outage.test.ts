import "./helpers/dead-rpc";
import "./helpers/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDb, type Db } from "@/lib/server/db";
import { freshDb } from "./helpers/db";
import * as healthRoute from "@/app/api/health/route";
import * as indexerRoute from "@/app/api/indexer/sync/route";
import * as claimRoute from "@/app/api/claims/[paymentId]/route";
import * as claimConfirmRoute from "@/app/api/claims/[paymentId]/confirm/route";
import type { HealthResponse } from "@/lib/api-types";

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  setDb(db);
}, 60_000);
afterAll(async () => {
  delete process.env.NEXT_PUBLIC_MEZO_RPC_URL;
  delete process.env.CHAIN_RPC_TIMEOUT_MS;
  delete process.env.INDEXER_SECRET;
  setDb(undefined);
  await db.close();
});

const PID = ((3n << 32n) | 1n).toString();
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request("http://payflow.test" + path, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });

describe("RPC outage (contracts deployed, RPC unreachable)", () => {
  it("/api/health reports rpc: down and ok: false (503)", async () => {
    const t0 = Date.now();
    const res = await healthRoute.GET();
    const body = (await res.json()) as HealthResponse;
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ ok: false, rpc: "down", deployed: true, latestBlock: null });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  it("chain reads fail fast with 503 chain_unavailable, not a bare 500", async () => {
    const t0 = Date.now();
    const res = await claimRoute.GET(req(`/api/claims/${PID}`, { headers: { "x-forwarded-for": "10.9.0.1" } }), { params: Promise.resolve({ paymentId: PID }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "chain_unavailable", message: expect.stringMatching(/not reachable/) } });
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  it("the indexer endpoint returns non-200 when its pass failed", async () => {
    process.env.INDEXER_SECRET = "s".repeat(32);
    const res = await indexerRoute.POST(req("/api/indexer/sync", { method: "POST", headers: { authorization: `Bearer ${"s".repeat(32)}` } }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { indexer: { error: string } } } };
    expect(body.error.code).toBe("chain_unavailable");
    expect(body.error.details.indexer.error).toBeTruthy();
  });

  it("claim confirmation needs no session: a signed-out recipient reaches the receipt check (503 while the RPC is down, never 401)", async () => {
    const res = await claimConfirmRoute.POST(
      req(`/api/claims/${PID}/confirm`, { method: "POST", headers: { "x-forwarded-for": "10.9.0.2" }, body: { txHash: "0x" + "ab".repeat(32) } }),
      { params: Promise.resolve({ paymentId: PID }) },
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("chain_unavailable");
  });

  it("claim confirmation is rate-limited per payment id, whatever the IP (429 before any RPC work)", async () => {
    const pid = ((7n << 32n) | 2n).toString();
    await db.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 30)`, [`claimConfirm:payment:${pid}`]);
    const t0 = Date.now();
    const res = await claimConfirmRoute.POST(
      req(`/api/claims/${pid}/confirm`, { method: "POST", headers: { "x-forwarded-for": "10.9.0.3" }, body: { txHash: "0x" + "ab".repeat(32) } }),
      { params: Promise.resolve({ paymentId: pid }) },
    );
    expect(res.status).toBe(429);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("claim confirmation is rate-limited per client IP", async () => {
    await db.query(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 30)`, ["claimConfirm:10.9.0.4"]);
    const res = await claimConfirmRoute.POST(
      req(`/api/claims/${PID}/confirm`, { method: "POST", headers: { "x-forwarded-for": "10.9.0.4" }, body: { txHash: "0x" + "ab".repeat(32) } }),
      { params: Promise.resolve({ paymentId: PID }) },
    );
    expect(res.status).toBe(429);
  });
});
