import "./helpers/env";
import { beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { setDb, type Db } from "@/lib/server/db";
import { freshDb } from "./helpers/db";
import * as nonceRoute from "@/app/api/auth/nonce/route";
import * as verifyRoute from "@/app/api/auth/verify/route";
import * as sessionRoute from "@/app/api/auth/session/route";
import * as orgsRoute from "@/app/api/orgs/route";
import * as orgRoute from "@/app/api/orgs/[orgId]/route";
import * as recipientsRoute from "@/app/api/orgs/[orgId]/recipients/route";
import * as importRoute from "@/app/api/orgs/[orgId]/recipients/import/route";
import * as runsRoute from "@/app/api/orgs/[orgId]/runs/route";
import * as runRoute from "@/app/api/orgs/[orgId]/runs/[runId]/route";
import * as runExportRoute from "@/app/api/orgs/[orgId]/runs/[runId]/export/route";
import * as dashboardRoute from "@/app/api/orgs/[orgId]/dashboard/route";
import * as csvValidateRoute from "@/app/api/csv/validate/route";
import * as templateRoute from "@/app/api/csv/template/route";
import * as notificationsRoute from "@/app/api/notifications/route";
import * as indexerRoute from "@/app/api/indexer/sync/route";
import type { CsvValidationReport, DashboardStats, Organization, Paginated, PayrollRun, PayrollRunDetail, Recipient } from "@/lib/api-types";

const account = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const BASE = "http://payflow.test";
let db: Db;
let cookie = "";

const req = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new Request(BASE + path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", host: "payflow.test", cookie, "x-forwarded-for": "10.0.0.1", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeAll(async () => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  db = await freshDb();
  setDb(db);
}, 60_000);

describe("API route wiring (handlers called directly, PGlite)", () => {
  let org: Organization;
  let run: PayrollRunDetail;

  it("rejects unauthenticated calls with the ApiError shape", async () => {
    const res = await orgsRoute.GET(req("/api/orgs"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: expect.any(String) } });
  });

  it("signs in with nonce → personal_sign → httpOnly session cookie", async () => {
    const n = await nonceRoute.POST(req("/api/auth/nonce", { method: "POST", body: { address: account.address } }));
    expect(n.status).toBe(200);
    const { message } = (await n.json()) as { message: string };
    expect(message).toContain("Domain: payflow.test");
    const signature = await account.signMessage({ message });
    const v = await verifyRoute.POST(req("/api/auth/verify", { method: "POST", body: { address: account.address, message, signature } }));
    expect(v.status).toBe(200);
    const setCookie = v.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    cookie = setCookie.split(";")[0]!;
    const s = await sessionRoute.GET(req("/api/auth/session"));
    expect(await s.json()).toEqual({ address: account.address.toLowerCase() });
  });

  it("creates an org (pending) with a metadata hash and lists it", async () => {
    const res = await orgsRoute.POST(req("/api/orgs", { method: "POST", body: { name: "Route Test Co", description: "x" } }));
    expect(res.status).toBe(201);
    org = (await res.json()) as Organization;
    expect(org).toMatchObject({ status: "pending", slug: "route-test-co", myRoles: 7, chainOrgId: null });
    expect(org.metadataHash).toMatch(/^0x[0-9a-f]{64}$/);
    const list = (await (await orgsRoute.GET(req("/api/orgs"))).json()) as Organization[];
    expect(list.map((o) => o.id)).toEqual([org.id]);
    const bad = await orgsRoute.POST(req("/api/orgs", { method: "POST", body: { name: "" } }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_input");
  });

  it("PATCH: metadata is frozen while pending; once active it recomputes the hash and flags it stale on-chain", async () => {
    const pending = await orgRoute.PATCH(req(`/api/orgs/${org.id}`, { method: "PATCH", body: { description: "new" } }), params({ orgId: org.id }));
    expect(pending.status).toBe(409);
    // Non-metadata settings are fine while pending.
    const days = await orgRoute.PATCH(req(`/api/orgs/${org.id}`, { method: "PATCH", body: { defaultClaimWindowDays: 30 } }), params({ orgId: org.id }));
    expect(((await days.json()) as Organization & { metadataChanged: boolean }).metadataChanged).toBe(false);
    await db.query(`UPDATE organizations SET status = 'active', chain_org_id = 900 WHERE id = $1`, [org.id]);
    const res = await orgRoute.PATCH(req(`/api/orgs/${org.id}`, { method: "PATCH", body: { description: "new" } }), params({ orgId: org.id }));
    const o = (await res.json()) as Organization & { metadataChanged: boolean };
    expect(o.description).toBe("new");
    expect(o.metadataHash).not.toBe(org.metadataHash);
    expect(o.metadataChanged).toBe(true);
    expect(res.headers.get("x-payflow-metadata")).toBe("stale");
  });

  it("recipients: create, duplicate wallet conflict, CSV import all-or-nothing", async () => {
    const p = params({ orgId: org.id });
    const r = await recipientsRoute.POST(req(`/api/orgs/${org.id}/recipients`, { method: "POST", body: { name: "Alice", walletAddress: "0x52908400098527886E0F7030069857D2E4169EE7", defaultAmount: "1500" } }), p);
    expect(r.status).toBe(201);
    expect(((await r.json()) as Recipient).defaultAmount).toBe("1500000000000000000000");
    const dup = await recipientsRoute.POST(req(`/api/orgs/${org.id}/recipients`, { method: "POST", body: { name: "Again", walletAddress: "0x52908400098527886e0f7030069857d2e4169ee7" } }), p);
    expect(dup.status).toBe(409);
    const badCsv = await importRoute.POST(req(`/api/orgs/${org.id}/recipients/import`, { method: "POST", body: { csv: "name,wallet_address\nBob,0x123\n" } }), p);
    expect(badCsv.status).toBe(400);
    const details = ((await badCsv.json()) as { error: { details: CsvValidationReport } }).error.details;
    expect(details.rows[0]!.issues[0]!.code).toBe("invalid_wallet");
    const okCsv = await importRoute.POST(req(`/api/orgs/${org.id}/recipients/import`, { method: "POST", body: { csv: "name,wallet_address,amount\nBob,0x8617E340B3D01FA5F11F306F4090FD50E238070D,10\nAlice B,0x52908400098527886E0F7030069857D2E4169EE7,\n" } }), p);
    expect(await okCsv.json()).toMatchObject({ imported: 1, updated: 1 });
    const list = (await (await recipientsRoute.GET(req(`/api/orgs/${org.id}/recipients?q=ali`), p)).json()) as Paginated<Recipient>;
    expect(list.total).toBe(1);
    expect(list.items[0]!.name).toBe("Alice B");
  });

  it("runs: create draft, edit, reject duplicates, export CSV safely", async () => {
    const p = params({ orgId: org.id });
    const body = {
      name: "Nov",
      paymentCategory: "salary",
      frequency: "one_time",
      items: [
        { name: "Alice", walletAddress: "0x52908400098527886E0F7030069857D2E4169EE7", amount: "100.5", description: "=cmd" },
        { name: "Bob", walletAddress: "0x8617E340B3D01FA5F11F306F4090FD50E238070D", amount: "50" },
      ],
    };
    const res = await runsRoute.POST(req(`/api/orgs/${org.id}/runs`, { method: "POST", body }), p);
    expect(res.status).toBe(201);
    run = (await res.json()) as PayrollRunDetail;
    expect(run).toMatchObject({ status: "draft", totalAmount: "150500000000000000000", recipientCount: 2, claimWindowDays: 30 });
    expect(run.items.map((i) => i.recipientAddress)).toEqual(["0x52908400098527886e0f7030069857d2e4169ee7", "0x8617e340b3d01fa5f11f306f4090fd50e238070d"]);

    const dupBody = { ...body, items: [body.items[0], { ...body.items[1], walletAddress: body.items[0]!.walletAddress }] };
    expect((await runsRoute.POST(req(`/api/orgs/${org.id}/runs`, { method: "POST", body: dupBody }), p)).status).toBe(400);

    const rp = params({ orgId: org.id, runId: run.id });
    const patched = (await (await runRoute.PATCH(req(`/api/orgs/${org.id}/runs/${run.id}`, { method: "PATCH", body: { name: "November" } }), rp)).json()) as PayrollRunDetail;
    expect(patched.name).toBe("November");
    expect(patched.items).toHaveLength(2);

    const csv = await (await runExportRoute.GET(req(`/api/orgs/${org.id}/runs/${run.id}/export`), rp)).text();
    expect(csv).toContain("'=cmd");
    const runs = (await (await runsRoute.GET(req(`/api/orgs/${org.id}/runs`), p)).json()) as PayrollRun[];
    expect(runs).toHaveLength(1);
  });

  it("dashboard is computed from DB data", async () => {
    const d = (await (await dashboardRoute.GET(req(`/api/orgs/${org.id}/dashboard`), params({ orgId: org.id }))).json()) as DashboardStats;
    expect(d).toMatchObject({ runCount: 1, recipientCount: 2, totalPaidWei: "0", outstandingWei: "0" });
    expect(d.monthlyVolume).toHaveLength(12);
    expect(d.recentActivity.length).toBeGreaterThan(0);
  });

  it("csv validate + template", async () => {
    const v = (await (await csvValidateRoute.POST(req("/api/csv/validate", { method: "POST", body: { csv: "name,wallet_address,amount\nA,0x52908400098527886E0F7030069857D2E4169EE7,1\n" } }))).json()) as CsvValidationReport;
    expect(v.validRows).toBe(1);
    const t = await templateRoute.GET(req("/api/csv/template?kind=recipients"));
    expect(t.headers.get("content-type")).toMatch(/text\/csv/);
    expect(await t.text()).toMatch(/^name,email,wallet_address,amount/);
  });

  it("a non-member cannot see the org", async () => {
    const saved = cookie;
    cookie = "";
    const res = await orgRoute.GET(req(`/api/orgs/${org.id}`), params({ orgId: org.id }));
    expect(res.status).toBe(401);
    cookie = saved;
    const missing = await orgRoute.GET(req(`/api/orgs/00000000-0000-4000-8000-000000000000`), params({ orgId: "00000000-0000-4000-8000-000000000000" }));
    expect(missing.status).toBe(404);
  });

  it("notifications list + indexer endpoint auth", async () => {
    expect((await notificationsRoute.GET(req("/api/notifications"))).status).toBe(200);
    delete process.env.INDEXER_SECRET;
    expect((await indexerRoute.POST(req("/api/indexer/sync", { method: "POST", headers: { authorization: "Bearer x" } }))).status).toBe(403);
    process.env.INDEXER_SECRET = "s".repeat(32);
    expect((await indexerRoute.POST(req("/api/indexer/sync", { method: "POST", headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    delete process.env.INDEXER_SECRET;
  });
});
