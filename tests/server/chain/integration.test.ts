/**
 * Chain-backed integration suite: real transactions on a local anvil (chain id 31611) against the
 * real contracts, with the API's server modules pointed at it via env and PGlite as the DB.
 * Skipped (with a message) only when anvil is not installed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { erc20Abi, type Abi, type Address, type Hex } from "viem";
import { findFoundryBin, startChain, type LocalChain, type Who } from "./anvil";

const HAS_ANVIL = findFoundryBin("anvil") !== null;
if (!HAS_ANVIL) console.warn("[chain suite] SKIPPED: anvil not found (install Foundry: https://getfoundry.sh)");

type Mods = {
  db: typeof import("@/lib/server/db");
  orgs: typeof import("@/lib/server/orgs");
  runs: typeof import("@/lib/server/runs");
  claims: typeof import("@/lib/server/claims");
  indexer: typeof import("@/lib/server/indexer");
  chain: typeof import("@/lib/server/chain");
  authz: typeof import("@/lib/server/authz");
  session: typeof import("@/lib/server/session");
  abis: typeof import("@/lib/chain/abis");
  txRoute: typeof import("@/app/api/orgs/[orgId]/runs/[runId]/tx/route");
  claimConfirmRoute: typeof import("@/app/api/claims/[paymentId]/confirm/route");
};

const ENV_KEYS = ["NEXT_PUBLIC_MEZO_RPC_URL", "NEXT_PUBLIC_MUSD_ADDRESS", "NEXT_PUBLIC_ESCROW_ADDRESS", "NEXT_PUBLIC_REGISTRY_ADDRESS", "NEXT_PUBLIC_DEPLOY_BLOCK", "NEXT_PUBLIC_APP_URL"] as const;
const E18 = 10n ** 18n;

describe.skipIf(!HAS_ANVIL)("chain-backed integration (anvil + real contracts + PGlite)", () => {
  let c: LocalChain;
  let m: Mods;
  let db: import("@/lib/server/db").Db;
  const saved: Record<string, string | undefined> = {};
  const W = {} as Record<Who, string>;
  let escrowAbi: Abi;
  let registryAbi: Abi;
  let org: import("@/lib/server/authz").OrgRow;
  let chainOrgId: bigint;

  const access = (who: Who) => m.authz.requireOrgRole(db, org.id, W[who], m.authz.MASK.ANY_MEMBER);
  const reloadOrg = async () => (org = await m.authz.loadOrg(db, org.id));
  const loadRunRow = (id: string) => m.runs.loadRun(db, org.id, id);
  const esc = (who: Who, fn: string, args: unknown[]) => c.write(who, c.escrow, escrowAbi, fn, args);
  const reg = (who: Who, fn: string, args: unknown[]) => c.write(who, c.registry, registryAbi, fn, args);

  async function newRun(name: string, items: { name: string; who: Who | Address; amount: bigint; description?: string }[], claimWindowDays = 30) {
    const input = {
      name, paymentCategory: "salary", frequency: "one_time" as const, scheduledAt: null, claimWindowDays,
      items: items.map((i) => ({ recipientId: null, name: i.name, email: null, department: null, walletAddress: (i.who.startsWith("0x") ? i.who.toLowerCase() : W[i.who as Who]) as `0x${string}`, amount: i.amount.toString(), description: i.description ?? "" })),
    };
    return m.runs.createRun(db, W.owner, org, input);
  }

  /** createRun on-chain + report it; returns the chain run id. */
  async function putOnChain(runId: string): Promise<bigint> {
    const plan = await m.runs.runPlan(db, await loadRunRow(runId));
    const h = await esc("owner", "createRun", [chainOrgId, plan.runRef, plan.claimWindowSeconds]);
    const d = await m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(runId), { action: "create", txHash: h });
    expect(d.status).toBe("onchain_draft");
    return BigInt(d.chainRunId!);
  }

  beforeAll(async () => {
    c = await startChain();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.NEXT_PUBLIC_MEZO_RPC_URL = c.rpcUrl;
    process.env.NEXT_PUBLIC_MUSD_ADDRESS = c.musd;
    process.env.NEXT_PUBLIC_ESCROW_ADDRESS = c.escrow;
    process.env.NEXT_PUBLIC_REGISTRY_ADDRESS = c.registry;
    process.env.NEXT_PUBLIC_DEPLOY_BLOCK = c.deployBlock.toString();
    delete process.env.NEXT_PUBLIC_APP_URL;
    vi.resetModules(); // lib/chain/config reads env at import time
    m = {
      db: await import("@/lib/server/db"),
      orgs: await import("@/lib/server/orgs"),
      runs: await import("@/lib/server/runs"),
      claims: await import("@/lib/server/claims"),
      indexer: await import("@/lib/server/indexer"),
      chain: await import("@/lib/server/chain"),
      authz: await import("@/lib/server/authz"),
      session: await import("@/lib/server/session"),
      abis: await import("@/lib/chain/abis"),
      txRoute: await import("@/app/api/orgs/[orgId]/runs/[runId]/tx/route"),
      claimConfirmRoute: await import("@/app/api/claims/[paymentId]/confirm/route"),
    };
    escrowAbi = m.abis.payrollEscrowAbi as Abi;
    registryAbi = m.abis.organizationRegistryAbi as Abi;
    for (const who of Object.keys({ owner: 1, approver: 1, admin: 1, alice: 1, bob: 1, stranger: 1 }) as Who[]) W[who] = c.account(who).address.toLowerCase();
    db = m.db.createPgliteDb("memory://", { autoMigrate: true });
    await db.query("SELECT 1");
    m.db.setDb(db);
    // Mint test MUSD to the owner (funder).
    await c.write("owner", c.musd, [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as Abi, "mint", [W.owner, 1_000_000n * E18]);
  }, 120_000);

  afterAll(async () => {
    m?.db.setDb(undefined);
    await db?.close();
    await c?.stop();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("creates and confirms the organization from the real createOrganization receipt", async () => {
    const created = await m.orgs.createOrg(db, W.owner, { name: "Chain Co", description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 30, email: "owner@chain.co" });
    org = await m.authz.loadOrg(db, created.id);
    const h = await reg("owner", "createOrganization", [created.metadataHash]);
    const o = await m.orgs.confirmOrg(db, W.owner, org, h);
    expect(o).toMatchObject({ status: "active", chainOrgId: "1" });
    chainOrgId = 1n;
    await reloadOrg();
    const owner = await db.query<{ email: string | null; roles: number }>(`SELECT email, roles FROM organization_members WHERE organization_id = $1 AND wallet_address = $2`, [org.id, W.owner]);
    expect(owner[0]).toEqual({ email: "owner@chain.co", roles: 7 });
  });

  it("members: tx-verified upsert; admins may manage operators only (registry rule mirrored)", async () => {
    const own = await access("owner");
    await m.orgs.upsertMember(db, W.owner, own, { walletAddress: W.approver as Hex, roles: 2, email: null, displayName: null, txHash: await reg("owner", "setMemberRoles", [chainOrgId, W.approver, 2]) });
    await m.orgs.upsertMember(db, W.owner, own, { walletAddress: W.admin as Hex, roles: 1, email: null, displayName: null, txHash: await reg("owner", "setMemberRoles", [chainOrgId, W.admin, 1]) });
    const adm = await access("admin");
    // The contract lets the admin add an operator…
    const op = "0x00000000000000000000000000000000000000c1" as Hex;
    const m1 = await m.orgs.upsertMember(db, W.admin, adm, { walletAddress: op, roles: 4, email: null, displayName: null, txHash: await reg("admin", "setMemberRoles", [chainOrgId, op, 4]) });
    expect(m1).toMatchObject({ roles: 4, status: "active" });
    // …but never an approver, so neither does the API, even when the tx (sent by the owner) exists.
    const ap = "0x00000000000000000000000000000000000000c2" as Hex;
    expect(await c.revertOf("admin", c.registry, registryAbi, "setMemberRoles", [chainOrgId, ap, 2])).toMatch(/NotOwner/);
    const ownerTx = await reg("owner", "setMemberRoles", [chainOrgId, ap, 2]);
    await expect(m.orgs.upsertMember(db, W.admin, adm, { walletAddress: ap, roles: 2, email: null, displayName: null, txHash: ownerTx })).rejects.toMatchObject({ code: "forbidden" });
    // Nor may an admin report removing an approver.
    const members = await m.orgs.listMembers(db, org.id);
    const approverRow = members.find((x) => x.walletAddress === W.approver)!;
    await expect(m.orgs.removeMember(db, W.admin, adm, approverRow.id, ownerTx)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("members: an older setMemberRoles tx cannot override newer on-chain roles (replay guard)", async () => {
    const own = await access("owner");
    const z = "0x00000000000000000000000000000000000000c3" as Hex;
    const tx1 = await reg("owner", "setMemberRoles", [chainOrgId, z, 4]);
    await reg("owner", "setMemberRoles", [chainOrgId, z, 0]);
    await expect(m.orgs.upsertMember(db, W.owner, own, { walletAddress: z, roles: 4, email: null, displayName: null, txHash: tx1 })).rejects.toThrow(/superseded/);
    const row = await db.query(`SELECT 1 FROM organization_members WHERE organization_id = $1 AND wallet_address = $2 AND status = 'active'`, [org.id, z]);
    expect(row).toHaveLength(0);
  });

  let run1: string;
  let chainRun1: bigint;
  const pid1 = (i: number) => (chainRun1 << 32n) | BigInt(i);

  it("applyRunTx: create → allocate → submit → approve → fund → publish against real receipts", async () => {
    const d0 = await newRun("November", [
      { name: "Alice", who: "alice", amount: 100n * E18, description: "Alice's private bonus note" },
      { name: "Bob", who: "bob", amount: 50n * E18, description: "Bob's note" },
    ]);
    run1 = d0.id;
    chainRun1 = await putOnChain(run1);
    const plan = await m.runs.runPlan(db, await loadRunRow(run1));
    expect(plan.batches).toHaveLength(1);
    const b = plan.batches[0]!;
    const hAlloc = await esc("owner", "addPayments", [chainRun1, b.expectedIndex, b.recipients, b.amounts.map(BigInt)]);
    let d = await m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(run1), { action: "allocate", txHash: hAlloc });
    expect(d.items.map((i) => i.claimStatus)).toEqual(["allocated", "allocated"]);
    expect(d.chainMismatch).toEqual([]);

    d = await m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(run1), { action: "submit", txHash: await esc("owner", "submitForApproval", [chainRun1]) });
    expect(d.status).toBe("pending_approval");
    expect(d).toMatchObject({ validApprovals: 0, approvalsRequired: 1 });

    const plan2 = await m.runs.runPlan(db, await loadRunRow(run1));
    const onchain = (await c.pub.readContract({ address: c.escrow, abi: escrowAbi, functionName: "getRun", args: [chainRun1] })) as { paymentsHash: Hex };
    expect(plan2.expectedPaymentsHash).toBe(onchain.paymentsHash);

    // The receipt must be a call TO the escrow: an MUSD approve reported as "fund" is refused.
    const notEscrow = await c.write("owner", c.musd, erc20Abi as Abi, "approve", [c.escrow, 150n * E18]);
    await expect(m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(run1), { action: "fund", txHash: notEscrow as Hex })).rejects.toThrow(/not sent to the PayFlow contract/);

    d = await m.runs.applyRunTx(db, W.approver, await access("approver"), await loadRunRow(run1), { action: "approve", txHash: await esc("approver", "approve", [chainRun1, plan2.expectedPaymentsHash]) });
    expect(d).toMatchObject({ status: "approved", validApprovals: 1, approvalsRequired: 1 });

    d = await m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(run1), { action: "fund", txHash: await esc("owner", "fund", [chainRun1]) });
    expect(d).toMatchObject({ status: "funded", fundedAmount: (150n * E18).toString() });
    d = await m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(run1), { action: "publish", txHash: await esc("owner", "publish", [chainRun1]) });
    expect(d.status).toBe("published");
    const avail = await db.query<{ wallet_address: string }>(`SELECT wallet_address FROM notifications WHERE kind = 'payment_available' ORDER BY wallet_address`);
    expect(avail.map((a) => a.wallet_address).sort()).toEqual([W.alice, W.bob].sort());
    const employer = await db.query<{ kind: string }>(`SELECT kind FROM notifications WHERE wallet_address = $1 AND kind LIKE 'run_%' ORDER BY created_at, id`, [W.owner]);
    expect(employer.map((e) => e.kind)).toEqual(["run_created", "run_awaiting_approval", "run_approved", "run_funded", "run_published"]);
  });

  it("confirmClaim records a real claim; the description is shown only to the recipient's session", async () => {
    const h = await esc("alice", "claim", [pid1(0)]);
    // A tx that does not claim this payment is refused.
    await expect(m.claims.confirmClaim(db, pid1(1).toString(), h, W.bob)).rejects.toThrow(/did not claim/);
    const info = await m.claims.confirmClaim(db, pid1(0).toString(), h, W.alice);
    expect(info).toMatchObject({ status: "claimed", transactionHash: h, description: "Alice's private bonus note" });
    expect((await m.claims.getClaimInfo(db, pid1(0).toString(), W.bob)).description).toBeNull();
    expect((await m.claims.getClaimInfo(db, pid1(0).toString(), null)).description).toBeNull();
    expect((await m.claims.getClaimInfo(db, pid1(1).toString(), W.bob)).description).toBe("Bob's note");
    // Via the route: session required, then the same verification.
    const { token } = await m.session.createSession(db, W.alice);
    const res = await m.claimConfirmRoute.POST(
      new Request(`http://payflow.test/api/claims/${pid1(0)}/confirm`, { method: "POST", headers: { "content-type": "application/json", cookie: `pf_session=${token}`, "x-forwarded-for": "10.7.0.1" }, body: JSON.stringify({ txHash: h }) }),
      { params: Promise.resolve({ paymentId: pid1(0).toString() }) },
    );
    expect(res.status).toBe(200);
  });

  it("syncRun picks up a claim made directly on-chain", async () => {
    await esc("bob", "claim", [pid1(1)]);
    const d = await m.runs.syncRun(db, W.owner, org, await loadRunRow(run1));
    expect(d.items.map((i) => i.claimStatus)).toEqual(["claimed", "claimed"]);
    expect(d.status).toBe("completed");
    expect(d.claimedAmount).toBe((150n * E18).toString());
  });

  it("B1: a wallet redirected on-chain is blocked on the /tx, indexer and sync paths", async () => {
    const d0 = await newRun("Redirect", [{ name: "Bob", who: "bob", amount: 7n * E18 }]);
    const cr = await putOnChain(d0.id);
    // The operator allocates to the attacker instead of Bob.
    const hAlloc = await esc("owner", "addPayments", [cr, 0, [W.stranger], [7n * E18]]);
    const err = await m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(d0.id), { action: "allocate", txHash: hAlloc }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "chain_mismatch", status: 409 });
    let d = await m.runs.runDetail(db, await loadRunRow(d0.id));
    expect(d.items[0]).toMatchObject({ name: "Bob", recipientAddress: W.bob });
    expect(d.chainMismatch).toEqual([{ index: 0, name: "Bob", reviewedRecipient: W.bob, reviewedAmount: (7n * E18).toString(), chainRecipient: W.stranger, chainAmount: (7n * E18).toString(), txHash: hAlloc }]);
    await expect(m.runs.runPlan(db, await loadRunRow(d0.id))).rejects.toMatchObject({ code: "chain_mismatch", status: 409 });
    // Submit is refused too (the on-chain tx happened; the API will not bless it).
    await expect(m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(d0.id), { action: "submit", txHash: await esc("owner", "submitForApproval", [cr]) })).rejects.toMatchObject({ code: "chain_mismatch", status: 409 });
    // The hash an approver could get from the reviewed draft does not match the chain, so approve() reverts.
    const reviewedHash = await m.runs.runManifest(db, await loadRunRow(d0.id));
    expect(await c.revertOf("approver", c.escrow, escrowAbi, "approve", [cr, reviewedHash.paymentsHash])).toMatch(/PaymentsHashMismatch|Mismatch/);
    // Indexer over the whole range and a chain sync leave the reviewed item untouched.
    await db.query(`DELETE FROM indexed_events`);
    await m.indexer.runIndexerPass(db, { latestBlock: m.chain.latestBlock, fetchLogs: m.chain.fetchLogs }, { confirmations: 0 });
    d = await m.runs.syncRun(db, W.owner, org, await loadRunRow(d0.id));
    expect(d.items[0]!.recipientAddress).toBe(W.bob);
    expect(d.chainMismatch).toHaveLength(1);
    // Members were alerted once; the dashboard shows it.
    const notes = await db.query(`SELECT 1 FROM notifications WHERE dedupe_key LIKE $1`, [`chain_mismatch:${d0.id}:%`]);
    expect(notes.length).toBeGreaterThanOrEqual(3); // owner, approver, admin (+ operator)
    const act = await db.query(`SELECT 1 FROM audit_logs WHERE action = 'run.chain_mismatch' AND resource_id = $1`, [d0.id]);
    expect(act).toHaveLength(1);
  });

  it("approvals of a revoked approver no longer count (live validApprovals; fund reverts)", async () => {
    const d0 = await newRun("Revoked", [{ name: "Alice", who: "alice", amount: 3n * E18 }]);
    const cr = await putOnChain(d0.id);
    await m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(d0.id), { action: "allocate", txHash: await esc("owner", "addPayments", [cr, 0, [W.alice], [3n * E18]]) });
    await m.runs.applyRunTx(db, W.owner, await access("owner"), await loadRunRow(d0.id), { action: "submit", txHash: await esc("owner", "submitForApproval", [cr]) });
    const plan = await m.runs.runPlan(db, await loadRunRow(d0.id));
    let d = await m.runs.applyRunTx(db, W.approver, await access("approver"), await loadRunRow(d0.id), { action: "approve", txHash: await esc("approver", "approve", [cr, plan.expectedPaymentsHash]) });
    expect(d).toMatchObject({ status: "approved", validApprovals: 1 });
    await reg("owner", "setMemberRoles", [chainOrgId, W.approver, 0]);
    d = await m.runs.runDetail(db, await loadRunRow(d0.id));
    expect(d).toMatchObject({ validApprovals: 0, approvalsRequired: 1 });
    expect(await c.revertOf("owner", c.escrow, escrowAbi, "fund", [cr])).toMatch(/ApprovalsRevoked/);
    await reg("owner", "setMemberRoles", [chainOrgId, W.approver, 2]); // restore for later tests
  });

  it("expire is permissionless: a non-member's session may report it; the RunExpired event is still verified", async () => {
    await c.increaseTime(31 * 86400);
    const { token } = await m.session.createSession(db, W.stranger);
    const call = (txHash: Hex) =>
      m.txRoute.POST(
        new Request(`http://payflow.test/api/orgs/${org.id}/runs/${run1}/tx`, { method: "POST", headers: { "content-type": "application/json", cookie: `pf_session=${token}`, "x-forwarded-for": "10.7.0.2" }, body: JSON.stringify({ action: "expire", txHash }) }),
        { params: Promise.resolve({ orgId: org.id, runId: run1 }) },
      );
    // A tx without RunExpired for this run is rejected.
    const unrelated = await c.write("stranger", c.musd, erc20Abi as Abi, "approve", [c.escrow, 1n]);
    expect((await call(unrelated as Hex)).status).toBe(422);
    const res = await call(await esc("stranger", "expireRun", [chainRun1]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "expired" }); // no private run data for non-members
    expect((await loadRunRow(run1)).status).toBe("expired");
    // Other actions still require membership.
    const fund = await m.txRoute.POST(
      new Request(`http://payflow.test/api/orgs/${org.id}/runs/${run1}/tx`, { method: "POST", headers: { "content-type": "application/json", cookie: `pf_session=${token}` }, body: JSON.stringify({ action: "refund", txHash: "0x" + "ab".repeat(32) }) }),
      { params: Promise.resolve({ orgId: org.id, runId: run1 }) },
    );
    expect(fund.status).toBe(404);
  });

  it("recover: a lost confirm call is recovered from the owner's OrganizationCreated log (earliest match)", async () => {
    const created = await m.orgs.createOrg(db, W.admin, { name: "Lost Co", description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 30 });
    const row = await m.authz.loadOrg(db, created.id);
    const h1 = await reg("admin", "createOrganization", [created.metadataHash]);
    await reg("admin", "createOrganization", [created.metadataHash]); // accidental second org on-chain
    const r = await m.orgs.recoverOrg(db, W.admin, row);
    expect(r).toMatchObject({ recovered: true, txHash: h1 });
    expect(r.organization).toMatchObject({ status: "active", chainOrgId: "2" });
    // Idempotent.
    expect((await m.orgs.recoverOrg(db, W.admin, await m.authz.loadOrg(db, created.id))).recovered).toBe(false);
  });

  it("the worker's indexer auto-activates a pending org when it sees its OrganizationCreated", async () => {
    const created = await m.orgs.createOrg(db, W.bob, { name: "Auto Co", description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 30 });
    await reg("bob", "createOrganization", [created.metadataHash]);
    await m.indexer.runIndexerPass(db, { latestBlock: m.chain.latestBlock, fetchLogs: m.chain.fetchLogs }, { confirmations: 0 });
    const o = await m.authz.loadOrg(db, created.id);
    expect(o.status).toBe("active");
    expect(String(o.chain_org_id)).toBe("4");
  });
});
