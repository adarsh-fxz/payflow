/**
 * Server-side chain access (viem public client on Mezo testnet, lib/chain/config).
 * Every money/status claim the API makes is verified here, never taken from the client.
 */
import "./guard";
import {
  createPublicClient,
  decodeEventLog,
  getAbiItem,
  http,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { erc20Abi, organizationRegistryAbi, payrollEscrowAbi } from "../chain/abis";
import { contracts, isDeployed, mezoTestnet } from "../chain/config";
import { ApiHttpError, fail } from "./http";
import { CHAIN_UNAVAILABLE_MESSAGE, isChainUnavailable } from "./chain-errors";

export interface ChainRun {
  orgId: bigint;
  runRef: Hex;
  paymentsHash: Hex;
  creator: string;
  funder: string;
  status: number;
  approvalsRequired: number;
  approvals: number;
  paymentCount: number;
  claimedCount: number;
  claimWindow: number;
  createdAt: bigint;
  fundedAt: bigint;
  publishedAt: bigint;
  claimDeadline: bigint;
  allocated: bigint;
  funded: bigint;
  claimed: bigint;
  refunded: bigint;
}

export interface ChainPayment {
  recipient: string;
  claimedAt: bigint;
  status: number;
  amount: bigint;
}

/** A decoded contract event, normalised (addresses lowercase). */
export interface ChainLog {
  address: string;
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: string;
  blockNumber: bigint;
  logIndex: number;
  blockTimestamp: Date | null;
}

export interface VerifiedReceipt {
  hash: string;
  status: "success" | "reverted";
  from: string;
  to: string | null;
  blockNumber: bigint;
  blockTimestamp: Date | null;
  logs: ChainLog[];
}

/** Per-request RPC timeout. Short on purpose: an outage must surface as 503 quickly, not hang a request. */
export const RPC_TIMEOUT_MS = Math.max(1_000, Number(process.env.CHAIN_RPC_TIMEOUT_MS ?? 6_000));

let client: PublicClient | null = null;
export function publicClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: mezoTestnet,
      transport: http(mezoTestnet.rpcUrls.default.http[0], { timeout: RPC_TIMEOUT_MS, retryCount: 1, retryDelay: 200 }),
    }) as PublicClient;
  }
  return client;
}

/** Maps an RPC outage to ApiHttpError(chain_unavailable, 503); everything else is rethrown untouched. */
export function chainError(e: unknown): unknown {
  if (e instanceof ApiHttpError) return e;
  return isChainUnavailable(e) ? fail("chain_unavailable", CHAIN_UNAVAILABLE_MESSAGE) : e;
}

/** Quick liveness probe for /api/health: eth_blockNumber with its own short timeout and no retries. */
export async function pingRpc(timeoutMs = 3_000): Promise<bigint | null> {
  const c = createPublicClient({ chain: mezoTestnet, transport: http(mezoTestnet.rpcUrls.default.http[0], { timeout: timeoutMs, retryCount: 0 }) });
  try {
    return await c.getBlockNumber({ cacheTime: 0 });
  } catch {
    return null;
  }
}

export function requireDeployed(): void {
  if (!isDeployed) throw fail("not_deployed", "PayFlow contracts are not deployed yet. Set NEXT_PUBLIC_ESCROW_ADDRESS and NEXT_PUBLIC_REGISTRY_ADDRESS");
}

const lc = (v: unknown) => String(v).toLowerCase();

/** Lowercases address args; bigint stays bigint. */
function normaliseArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args && typeof args === "object") {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      out[k] = typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
    }
  }
  return out;
}

/** Decodes logs from the escrow / registry only; other contracts' logs (e.g. MUSD Transfer) are dropped. */
export function decodeLogs(logs: readonly Log[], blockTimestamp: (bn: bigint) => Date | null = () => null): ChainLog[] {
  const out: ChainLog[] = [];
  const escrow = lc(contracts.escrow);
  const registry = lc(contracts.registry);
  for (const log of logs) {
    const addr = lc(log.address);
    const abi = addr === escrow ? payrollEscrowAbi : addr === registry ? organizationRegistryAbi : null;
    if (!abi || log.blockNumber === null || log.logIndex === null || log.transactionHash === null) continue;
    try {
      const d = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
      if (!d.eventName) continue;
      out.push({
        address: addr,
        eventName: d.eventName,
        args: normaliseArgs(d.args),
        transactionHash: log.transactionHash.toLowerCase(),
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        blockTimestamp: blockTimestamp(log.blockNumber),
      });
    } catch {
      // Not one of our events (e.g. AccessControl RoleGranted) — ignore.
    }
  }
  return out;
}

const blockTimeCache = new Map<bigint, Date>();
export async function blockTimestamps(blocks: Iterable<bigint>): Promise<Map<bigint, Date>> {
  const res = new Map<bigint, Date>();
  for (const bn of new Set(blocks)) {
    let t = blockTimeCache.get(bn);
    if (!t) {
      const b = await publicClient().getBlock({ blockNumber: bn });
      t = new Date(Number(b.timestamp) * 1000);
      if (blockTimeCache.size > 5000) blockTimeCache.clear();
      blockTimeCache.set(bn, t);
    }
    res.set(bn, t);
  }
  return res;
}

/**
 * Fetches and decodes a tx receipt. By default there is NO polling: a tx that is not mined yet is a
 * 409 conflict ("not mined yet") returned immediately. `waitMs` > 0 allows a short wait (RPC nodes
 * behind a load balancer can lag by a block behind the wallet's node).
 */
export async function fetchReceipt(hash: Hex, opts: { waitMs?: number } = {}): Promise<VerifiedReceipt> {
  requireDeployed();
  const c = publicClient();
  const notMined = () => fail("conflict", "Transaction is not mined yet. Try again in a few seconds");
  let receipt: TransactionReceipt;
  try {
    receipt = await c.getTransactionReceipt({ hash });
  } catch (e) {
    const name = (e as { name?: string }).name ?? "";
    if (!/NotFound/i.test(name)) throw chainError(e);
    if (!opts.waitMs || opts.waitMs <= 0) throw notMined();
    try {
      receipt = await c.waitForTransactionReceipt({ hash, timeout: opts.waitMs, pollingInterval: 1_000, retryCount: 0 });
    } catch (e2) {
      const n2 = (e2 as { name?: string }).name ?? "";
      if (/Timeout|NotFound/i.test(n2)) throw notMined();
      throw chainError(e2);
    }
  }
  const ts = (await blockTimestamps([receipt.blockNumber])).get(receipt.blockNumber) ?? null;
  return {
    hash: receipt.transactionHash.toLowerCase(),
    status: receipt.status,
    from: lc(receipt.from),
    to: receipt.to ? lc(receipt.to) : null,
    blockNumber: receipt.blockNumber,
    blockTimestamp: ts,
    logs: decodeLogs(receipt.logs, () => ts),
  };
}

/** Receipt must be a successful call to `target` (escrow or registry). */
export function assertSuccessfulCall(r: VerifiedReceipt, target: string): void {
  if (r.status !== "success") throw fail("chain_mismatch", "Transaction reverted on-chain");
  if (r.to !== target.toLowerCase()) throw fail("chain_mismatch", "Transaction was not sent to the PayFlow contract");
}

export async function readRun(runId: bigint): Promise<ChainRun> {
  requireDeployed();
  const r = await publicClient().readContract({ address: contracts.escrow, abi: payrollEscrowAbi, functionName: "getRun", args: [runId] });
  return {
    orgId: r.orgId,
    runRef: r.runRef,
    paymentsHash: r.paymentsHash,
    creator: lc(r.creator),
    funder: lc(r.funder),
    status: Number(r.status),
    approvalsRequired: Number(r.approvalsRequired),
    approvals: Number(r.approvals),
    paymentCount: Number(r.paymentCount),
    claimedCount: Number(r.claimedCount),
    claimWindow: Number(r.claimWindow),
    createdAt: BigInt(r.createdAt),
    fundedAt: BigInt(r.fundedAt),
    publishedAt: BigInt(r.publishedAt),
    claimDeadline: BigInt(r.claimDeadline),
    allocated: BigInt(r.allocated),
    funded: BigInt(r.funded),
    claimed: BigInt(r.claimed),
    refunded: BigInt(r.refunded),
  };
}

function toPayment(p: { recipient: string; claimedAt: bigint | number; status: number; amount: bigint }): ChainPayment {
  return { recipient: lc(p.recipient), claimedAt: BigInt(p.claimedAt), status: Number(p.status), amount: BigInt(p.amount) };
}

export async function readPayments(runId: bigint, paymentCount: number): Promise<ChainPayment[]> {
  requireDeployed();
  const out: ChainPayment[] = [];
  const PAGE = 500;
  for (let from = 0; from < paymentCount; from += PAGE) {
    const page = await publicClient().readContract({
      address: contracts.escrow, abi: payrollEscrowAbi, functionName: "getPayments", args: [runId, from, PAGE],
    });
    for (const p of page) out.push(toPayment(p));
  }
  return out;
}

/** null when the payment does not exist (contract reverts PaymentNotFound). */
export async function readPayment(paymentId: bigint): Promise<ChainPayment | null> {
  requireDeployed();
  try {
    const p = await publicClient().readContract({ address: contracts.escrow, abi: payrollEscrowAbi, functionName: "getPayment", args: [paymentId] });
    return toPayment(p);
  } catch (e) {
    if (/PaymentNotFound|RunNotFound|reverted/i.test(String((e as Error).message))) return null;
    throw e;
  }
}

export async function readEscrowTotals(): Promise<{ totalHeld: bigint; balance: bigint }> {
  requireDeployed();
  const c = publicClient();
  const [totalHeld, balance] = await Promise.all([
    c.readContract({ address: contracts.escrow, abi: payrollEscrowAbi, functionName: "totalHeld" }),
    c.readContract({ address: contracts.musd, abi: erc20Abi, functionName: "balanceOf", args: [contracts.escrow] }),
  ]);
  return { totalHeld: BigInt(totalHeld), balance: BigInt(balance) };
}

export async function latestBlock(): Promise<bigint> {
  return publicClient().getBlockNumber({ cacheTime: 0 }); // never a cached (stale) head
}

export async function fetchLogs(fromBlock: bigint, toBlock: bigint): Promise<ChainLog[]> {
  requireDeployed();
  const raw = await publicClient().getLogs({ address: [contracts.escrow, contracts.registry], fromBlock, toBlock });
  const times = await blockTimestamps(raw.map((l) => l.blockNumber).filter((b): b is bigint => b !== null));
  return decodeLogs(raw, (bn) => times.get(bn) ?? null);
}

export async function readRolesOf(chainOrgId: bigint, account: string): Promise<number> {
  requireDeployed();
  const r = await publicClient().readContract({
    address: contracts.registry, abi: organizationRegistryAbi, functionName: "rolesOf", args: [chainOrgId, account as `0x${string}`],
  });
  return Number(r);
}

export async function readRunIdByRef(chainOrgId: bigint, runRef: Hex): Promise<bigint> {
  requireDeployed();
  return publicClient().readContract({ address: contracts.escrow, abi: payrollEscrowAbi, functionName: "runIdByRef", args: [chainOrgId, runRef] });
}

/** Approvals still backed by wallets that hold APPROVER right now (PayrollEscrow.validApprovals). */
export async function readValidApprovals(runId: bigint): Promise<number> {
  requireDeployed();
  return Number(await publicClient().readContract({ address: contracts.escrow, abi: payrollEscrowAbi, functionName: "validApprovals", args: [runId] }));
}

export interface OrgCreatedLog { orgId: bigint; owner: string; metadataHash: string; txHash: string; blockNumber: bigint; logIndex: number }

/** OrganizationCreated logs for `owner` (indexed topic) in [from, to]. Caller keeps the range ≤ 5,000 blocks. */
export async function fetchOrgCreatedLogs(owner: string, fromBlock: bigint, toBlock: bigint): Promise<OrgCreatedLog[]> {
  requireDeployed();
  const event = getAbiItem({ abi: organizationRegistryAbi, name: "OrganizationCreated" });
  const raw = await publicClient().getLogs({ address: contracts.registry, event, args: { owner: owner as Hex }, fromBlock, toBlock });
  return raw
    .filter((l) => l.blockNumber !== null && l.logIndex !== null && l.transactionHash !== null)
    .map((l) => ({
      orgId: BigInt(l.args.orgId ?? 0n),
      owner: lc(l.args.owner),
      metadataHash: lc(l.args.metadataHash),
      txHash: l.transactionHash!.toLowerCase(),
      blockNumber: l.blockNumber!,
      logIndex: l.logIndex!,
    }));
}

/** Highest block whose timestamp is ≤ `at` (binary search, ~log2(head) getBlock calls). */
export async function blockAtOrBefore(at: Date, low: bigint, high: bigint): Promise<bigint> {
  const target = BigInt(Math.floor(at.getTime() / 1000));
  let lo = low;
  let hi = high;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const b = await publicClient().getBlock({ blockNumber: mid });
    if (b.timestamp <= target) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}
