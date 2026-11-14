import { ESCROW } from "./helpers/env";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, type Address } from "viem";
import { paymentsHash } from "@/lib/chain/commitment";
import { MEZO_TESTNET_ID } from "@/lib/chain/config";
import { buildBatches, buildManifest, verifyRunEvents } from "@/lib/server/runs";
import { expectedPaymentsHash, runRefOf } from "@/lib/server/runsync";
import { applyLogs } from "@/lib/server/indexer";
import type { ItemRow, RunRow } from "@/lib/server/dto";
import { ApiHttpError } from "@/lib/server/http";
import { freshDb } from "./helpers/db";
import { log, nextTx } from "./helpers/logs";

const RUN_ID = 3n;
const pid = (i: number) => (RUN_ID << 32n) | BigInt(i);
const addr = (i: number) => `0x${(0xc0de0000 + i).toString(16).padStart(40, "0")}` as Address;

function items(n: number, opts: { allocated?: number; cancelled?: number[] } = {}): ItemRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: crypto.randomUUID(),
    payroll_run_id: "r",
    recipient_id: null,
    item_index: i,
    name: `R${i}`,
    email: null,
    department: null,
    recipient_address: addr(i),
    amount: String(BigInt(i + 1) * 10n ** 18n),
    description: "",
    payment_id: i < (opts.allocated ?? 0) ? pid(i).toString() : null,
    claim_status: opts.cancelled?.includes(i) ? "cancelled" : i < (opts.allocated ?? 0) ? "allocated" : "pending",
    allocate_tx_hash: null,
    transaction_hash: null,
    claimed_at: null,
    chain_recipient_address: null,
    chain_amount: null,
    reviewed: true,
  }));
}

const run = (over: Partial<RunRow> = {}) =>
  ({ id: "00000000-0000-4000-8000-000000000001", chain_run_id: RUN_ID.toString(), run_ref: runRefOf("00000000-0000-4000-8000-000000000001"), claim_window_days: 30, token_address: "0x118917a40faf1cd7a13db0ef56c86de7973ac503", ...over }) as RunRow;

/** Independent re-implementation of the Solidity rolling hash (abi.encode). */
function solidityHash(ops: ({ add: true; i: number; to: Address; amt: bigint } | { add: false; i: number })[]) {
  let h = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint32" }], [BigInt(MEZO_TESTNET_ID), ESCROW as Address, RUN_ID, 30 * 86400]));
  for (const op of ops) {
    h = keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint128" }], [
        h,
        pid(op.i),
        op.add ? op.to : "0x0000000000000000000000000000000000000000",
        op.add ? op.amt : 0n,
      ]),
    );
  }
  return h;
}

describe("paymentsHash / manifest generation", () => {
  it("server expectation equals lib/chain/commitment and the Solidity encoding (index order)", async () => {
    const db = await freshDb();
    const its = items(3);
    const ours = await expectedPaymentsHash(db, run(), its);
    const lib = paymentsHash(MEZO_TESTNET_ID, ESCROW as Address, RUN_ID, 30 * 86400, its.map((i) => ({ kind: "add" as const, index: i.item_index, recipient: i.recipient_address as Address, amount: BigInt(i.amount) })));
    expect(ours).toBe(lib);
    expect(ours).toBe(solidityHash(its.map((i) => ({ add: true as const, i: i.item_index, to: i.recipient_address as Address, amt: BigInt(i.amount) }))));
    await db.close();
  });

  it("uses on-chain event order when a draft cancel happened between batches", async () => {
    const db = await freshDb();
    // adds 0,1 → cancel 0 → add 2 (chain order)
    const its = items(3, { allocated: 3, cancelled: [0] });
    const t1 = nextTx();
    const t2 = nextTx();
    const t3 = nextTx();
    await applyLogs(db, [
      log("escrow", "PaymentAllocated", { paymentId: pid(0), runId: RUN_ID, recipient: addr(0), amount: 1n * 10n ** 18n }, t1, 0, 10n),
      log("escrow", "PaymentAllocated", { paymentId: pid(1), runId: RUN_ID, recipient: addr(1), amount: 2n * 10n ** 18n }, t1, 1, 10n),
      log("escrow", "PaymentCancelled", { paymentId: pid(0), runId: RUN_ID, amount: 1n * 10n ** 18n }, t2, 0, 11n),
      log("escrow", "PaymentAllocated", { paymentId: pid(2), runId: RUN_ID, recipient: addr(2), amount: 3n * 10n ** 18n }, t3, 0, 12n),
    ]);
    const ours = await expectedPaymentsHash(db, run(), its);
    expect(ours).toBe(
      solidityHash([
        { add: true, i: 0, to: addr(0), amt: 1n * 10n ** 18n },
        { add: true, i: 1, to: addr(1), amt: 2n * 10n ** 18n },
        { add: false, i: 0 },
        { add: true, i: 2, to: addr(2), amt: 3n * 10n ** 18n },
      ]),
    );
    await db.close();
  });

  it("falls back to (block, logIndex) order when some events are not indexed yet", async () => {
    const db = await freshDb();
    // Chain: batch1 adds 0,1 (block 20) → cancel 0 (block 21) → batch2 adds 2,3 (block 22, NOT indexed).
    const its = items(4, { allocated: 4, cancelled: [0] });
    await applyLogs(db, [
      log("escrow", "PaymentAllocated", { paymentId: pid(0), runId: RUN_ID, recipient: addr(0), amount: 1n * 10n ** 18n }, nextTx(), 0, 20n),
      log("escrow", "PaymentAllocated", { paymentId: pid(1), runId: RUN_ID, recipient: addr(1), amount: 2n * 10n ** 18n }, nextTx(), 1, 20n),
      log("escrow", "PaymentCancelled", { paymentId: pid(0), runId: RUN_ID, amount: 1n * 10n ** 18n }, nextTx(), 0, 21n),
    ]);
    expect(await expectedPaymentsHash(db, run(), its)).toBe(
      solidityHash([
        { add: true, i: 0, to: addr(0), amt: 1n * 10n ** 18n },
        { add: true, i: 1, to: addr(1), amt: 2n * 10n ** 18n },
        { add: false, i: 0 },
        { add: true, i: 2, to: addr(2), amt: 3n * 10n ** 18n },
        { add: true, i: 3, to: addr(3), amt: 4n * 10n ** 18n },
      ]),
    );
    await db.close();
  });

  it("is computed from the REVIEWED items only, never from what the chain allocated", async () => {
    const db = await freshDb();
    const its = items(1, { allocated: 1 });
    const attacker = addr(66);
    await applyLogs(db, [log("escrow", "PaymentAllocated", { paymentId: pid(0), runId: RUN_ID, recipient: attacker, amount: 1n * 10n ** 18n }, nextTx(), 0, 30n)]);
    const ours = await expectedPaymentsHash(db, run(), [{ ...its[0]!, chain_recipient_address: attacker, chain_amount: String(10n ** 18n) }]);
    expect(ours).toBe(solidityHash([{ add: true, i: 0, to: addr(0), amt: 1n * 10n ** 18n }]));
    expect(ours).not.toBe(solidityHash([{ add: true, i: 0, to: attacker, amt: 1n * 10n ** 18n }]));
    // An on-chain payment with no reviewed item is never part of the expectation.
    const extra = { ...its[0]!, id: crypto.randomUUID(), item_index: 1, payment_id: pid(1).toString(), recipient_address: attacker, reviewed: false };
    expect(await expectedPaymentsHash(db, run(), [its[0]!, extra])).toBe(ours);
    await db.close();
  });

  it("is null before the run exists on-chain", async () => {
    const db = await freshDb();
    expect(await expectedPaymentsHash(db, run({ chain_run_id: null }), items(2))).toBeNull();
    await db.close();
  });

  it("builds sequential batches of ≤100 starting at the on-chain paymentCount", () => {
    const b = buildBatches(items(250, { allocated: 30 }));
    expect(b.map((x) => [x.expectedIndex, x.recipients.length])).toEqual([[30, 100], [130, 100], [230, 20]]);
    expect(b[0]!.amounts[0]).toBe((31n * 10n ** 18n).toString());
    expect(buildBatches(items(5, { allocated: 5 }))).toEqual([]);
  });

  it("manifest is deterministic, has no names/emails, and excludes cancelled from totals", () => {
    const its = items(3, { allocated: 3, cancelled: [1] });
    const m1 = buildManifest(run(), its, "0x" + "ab".repeat(32) as `0x${string}`);
    const m2 = buildManifest(run(), [...its].reverse(), "0x" + "ab".repeat(32) as `0x${string}`);
    expect(m1.manifestHash).toBe(m2.manifestHash);
    expect(m1.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(m1.totalAmount).toBe((4n * 10n ** 18n).toString());
    expect(m1.recipientCount).toBe(2);
    expect(JSON.stringify(m1)).not.toMatch(/R0|R1|email/);
  });
});

describe("verifyRunEvents", () => {
  const its = items(2);
  it("accepts allocations matching the DB items in order", () => {
    const tx = nextTx();
    const logs = [0, 1].map((i) => log("escrow", "PaymentAllocated", { paymentId: pid(i), runId: RUN_ID, recipient: addr(i), amount: BigInt(i + 1) * 10n ** 18n }, tx, i));
    expect(verifyRunEvents("allocate", run(), "1", its, logs)).toHaveLength(2);
  });
  it("rejects a recipient or amount that differs from the DB", () => {
    const tx = nextTx();
    const bad = [log("escrow", "PaymentAllocated", { paymentId: pid(0), runId: RUN_ID, recipient: addr(9), amount: 10n ** 18n }, tx, 0)];
    expect(() => verifyRunEvents("allocate", run(), "1", its, bad)).toThrow(ApiHttpError);
    const bad2 = [log("escrow", "PaymentAllocated", { paymentId: pid(0), runId: RUN_ID, recipient: addr(0), amount: 2n }, tx, 0)];
    expect(() => verifyRunEvents("allocate", run(), "1", its, bad2)).toThrow(/amount differs/);
  });
  it("rejects events for another run, org or runRef", () => {
    const tx = nextTx();
    expect(() => verifyRunEvents("fund", run(), "1", its, [log("escrow", "RunFunded", { runId: 99n, funder: addr(1), amount: 1n }, tx, 0)])).toThrow(/no RunFunded/);
    const created = log("escrow", "RunCreated", { runId: RUN_ID, orgId: 2n, runRef: run().run_ref, creator: addr(1), claimWindow: 30 * 86400 }, tx, 0);
    expect(() => verifyRunEvents("create", run({ chain_run_id: null }), "1", its, [created])).toThrow(/different organization/);
    const otherRef = log("escrow", "RunCreated", { runId: RUN_ID, orgId: 1n, runRef: "0x" + "00".repeat(32), creator: addr(1), claimWindow: 30 * 86400 }, tx, 0);
    expect(() => verifyRunEvents("create", run({ chain_run_id: null }), "1", its, [otherRef])).toThrow(/runRef/);
  });
  it("ignores look-alike events from other contracts", () => {
    const fake = { ...log("escrow", "RunFunded", { runId: RUN_ID, funder: addr(1), amount: 1n }, nextTx(), 0), address: "0x9999999999999999999999999999999999999999" };
    expect(() => verifyRunEvents("fund", run(), "1", its, [fake])).toThrow(/no RunFunded/);
  });
});
