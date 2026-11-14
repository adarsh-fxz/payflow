import "./helpers/env";
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { Db } from "@/lib/server/db";
import { applyLogs } from "@/lib/server/indexer";
import { createOrg } from "@/lib/server/orgs";
import { createRun } from "@/lib/server/runs";
import { expectedPaymentsHash } from "@/lib/server/runsync";
import { hasMismatch, runMismatches } from "@/lib/server/lifecycle";
import { paymentsHash } from "@/lib/chain/commitment";
import { contracts, MEZO_TESTNET_ID } from "@/lib/chain/config";
import type { RunRow } from "@/lib/server/dto";
import type { OrgRow } from "@/lib/server/authz";
import { freshDb } from "./helpers/db";
import { log, nextTx } from "./helpers/logs";

// solidity-auditor scan (2026-11-12): the claim window is part of what approvers sign.
const OWNER = "0xaaaa000000000000000000000000000000000021";
const R1 = "0xbbbb000000000000000000000000000000000021";
const E18 = 10n ** 18n;

async function setup(db: Db, chainOrgId: bigint): Promise<RunRow> {
  const o = await createOrg(db, OWNER, { name: `Window Co ${chainOrgId}`, description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 30, email: null });
  await applyLogs(db, [log("registry", "OrganizationCreated", { orgId: chainOrgId, owner: OWNER, metadataHash: o.metadataHash }, nextTx(), 0)]);
  const org = (await db.query<OrgRow>(`SELECT * FROM organizations WHERE id = $1`, [o.id]))[0]!;
  const d = await createRun(db, OWNER, org, {
    name: "Window run", paymentCategory: "salary", frequency: "one_time", scheduledAt: null, claimWindowDays: 30,
    items: [{ recipientId: null, name: "Alice", email: null, department: null, walletAddress: R1 as Address, amount: (100n * E18).toString(), description: "" }],
  });
  return (await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [d.id]))[0]!;
}
const reload = async (db: Db, id: string) => (await db.query<RunRow>(`SELECT * FROM payroll_runs WHERE id = $1`, [id]))[0]!;

describe("claim window binding", () => {
  it("the commitment changes with the claim window", () => {
    const ops = [{ kind: "add" as const, index: 0, recipient: R1 as Address, amount: 100n * E18 }];
    const month = paymentsHash(MEZO_TESTNET_ID, contracts.escrow, 7n, 30 * 86400, ops);
    const hour = paymentsHash(MEZO_TESTNET_ID, contracts.escrow, 7n, 3600, ops);
    expect(month).not.toBe(hour);
  });

  it("a run created on-chain with a shorter window keeps the reviewed window and is blocked", async () => {
    const db = await freshDb();
    const run = await setup(db, 71n);
    await applyLogs(db, [log("escrow", "RunCreated", { runId: 9n, orgId: 71n, runRef: run.run_ref, creator: OWNER, claimWindow: 3600 }, nextTx(), 0)]);
    const after = await reload(db, run.id);
    expect(Number(after.claim_window_days)).toBe(30); // reviewed value never overwritten
    expect(Number(after.chain_claim_window_seconds)).toBe(3600);
    expect(await hasMismatch(db, run.id)).toBe(true);
    const m = await runMismatches(db, run.id);
    expect(m[0]).toMatchObject({ kind: "claim_window", reviewedClaimWindowSeconds: 30 * 86400, chainClaimWindowSeconds: 3600 });
    // The hash approvers are shown is built from the reviewed 30-day window, so it can't match the 1-hour run.
    const expected = await expectedPaymentsHash(db, after, []);
    expect(expected).toBe(paymentsHash(MEZO_TESTNET_ID, contracts.escrow, 9n, 30 * 86400, []));
    await db.close();
  });

  it("a matching window is not flagged", async () => {
    const db = await freshDb();
    const run = await setup(db, 72n);
    await applyLogs(db, [log("escrow", "RunCreated", { runId: 10n, orgId: 72n, runRef: run.run_ref, creator: OWNER, claimWindow: 30 * 86400 }, nextTx(), 0)]);
    expect(await hasMismatch(db, run.id)).toBe(false);
    expect(Number((await reload(db, run.id)).chain_claim_window_seconds)).toBe(30 * 86400);
    await db.close();
  });
});
