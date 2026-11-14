/**
 * Full two-wallet PayFlow demo on Mezo Testnet, driven through the real API + real transactions.
 *
 *   APP_URL=http://localhost:3000 npx tsx scripts/demo-testnet.ts
 *
 * Needs: contracts deployed + NEXT_PUBLIC_* set for the running app; DEPLOYER_PRIVATE_KEY in contracts/.env
 * (employer, Wallet A, holds MUSD + BTC). Recipient wallets B and C are generated once and kept in
 * contracts/.demo-wallets.local.json (gitignored); A sends each a little BTC for claim gas.
 * Writes every tx hash to contracts/deployments/demo-31611.json.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatUnits, type Abi, type Hex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
import { mezoTestnet, contracts, isDeployed, explorerTx } from "../lib/chain/config";
import { payrollEscrowAbi, organizationRegistryAbi, erc20Abi } from "../lib/chain/abis";

const APP = process.env.APP_URL || "http://localhost:3000";
const env: Record<string, string> = process.env.DEPLOYER_PRIVATE_KEY ? { DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY } : Object.fromEntries(
  readFileSync("contracts/.env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => l.split("=").map((s) => s.trim()) as [string, string]),
);
const employer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);

const OUT = process.env.DEMO_OUT || "contracts/deployments/demo-31611";
const walletsFile = process.env.DEMO_WALLETS || "contracts/.demo-wallets.local.json";
const keys: Hex[] = existsSync(walletsFile) ? JSON.parse(readFileSync(walletsFile, "utf8")) : [generatePrivateKey(), generatePrivateKey()];
writeFileSync(walletsFile, JSON.stringify(keys));
const [walletB, walletC] = keys.map((k) => privateKeyToAccount(k));

const pub = createPublicClient({ chain: mezoTestnet, transport: http() });
const log: Record<string, unknown> = { startedAt: new Date().toISOString(), employer: employer.address, recipients: [walletB.address, walletC.address], txs: {} as Record<string, string> };
const txs = log.txs as Record<string, string>;

type Call = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

async function send(acct: PrivateKeyAccount, label: string, req: Call | { to: Address; value: bigint }) {
  const w = createWalletClient({ account: acct, chain: mezoTestnet, transport: http() });
  const hash = "abi" in req ? await w.writeContract({ ...req, account: acct, chain: mezoTestnet } as never) : await w.sendTransaction({ ...req, account: acct, chain: mezoTestnet });
  const r = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  txs[label] = hash;
  console.log(`  ✓ ${label.padEnd(28)} ${explorerTx(hash)}`);
  return hash;
}

class Api {
  cookie = "";
  constructor(private acct: PrivateKeyAccount) {}
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(APP + path, { method, headers: { "content-type": "application/json", cookie: this.cookie, origin: APP }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
  }
  async signIn() {
    const n = await this.call<{ message: string }>("POST", "/api/auth/nonce", { address: this.acct.address });
    const signature = await this.acct.signMessage({ message: n.message });
    await this.call("POST", "/api/auth/verify", { address: this.acct.address, message: n.message, signature });
  }
}

async function main() {
  if (!isDeployed) throw new Error("NEXT_PUBLIC_ESCROW_ADDRESS / NEXT_PUBLIC_REGISTRY_ADDRESS not set");
  const health = await (await fetch(`${APP}/api/health`)).json();
  if (!health.deployed || health.escrow.toLowerCase() !== contracts.escrow.toLowerCase()) throw new Error(`app at ${APP} is not configured with escrow ${contracts.escrow}`);

  const musdBal = await pub.readContract({ address: contracts.musd, abi: erc20Abi, functionName: "balanceOf", args: [employer.address] });
  console.log(`Employer ${employer.address}: ${formatUnits(musdBal, 18)} MUSD`);

  // ---- employer: org ----
  const A = new Api(employer);
  await A.signIn();
  console.log("1. Create organization");
  const org = await A.call<{ id: string; slug: string; metadataHash: Hex }>("POST", "/api/orgs", { name: `Demo Labs ${Date.now().toString(36)}`, description: "PayFlow testnet demo", defaultClaimWindowDays: 30 });
  const orgTx = await send(employer, "createOrganization", { address: contracts.registry, abi: organizationRegistryAbi, functionName: "createOrganization", args: [org.metadataHash] });
  const confirmed = await A.call<{ chainOrgId: string }>("POST", `/api/orgs/${org.id}/confirm`, { txHash: orgTx });
  log.org = { id: org.id, slug: org.slug, chainOrgId: confirmed.chainOrgId };

  // ---- recipients via CSV (10 rows; B and C are real wallets we control) ----
  console.log("2. Import 10 recipients from CSV + validate payroll CSV");
  const others = Array.from({ length: 8 }, () => privateKeyToAccount(generatePrivateKey()).address);
  const people = [walletB.address, walletC.address, ...others].map((w, i) => ({ name: `Contributor ${i + 1}`, email: `c${i + 1}@example.com`, wallet: w, amount: (1 + i * 0.5).toFixed(2), dept: i % 2 ? "Design" : "Engineering" }));
  const csv = ["name,email,wallet_address,amount,description,department", ...people.map((p) => `${p.name},${p.email},${p.wallet},${p.amount},November payroll,${p.dept}`)].join("\n");
  const report = await A.call<{ validRows: number; totalRows: number; totalPayableWei: string }>("POST", "/api/csv/validate", { csv });
  console.log(`  report: ${report.validRows}/${report.totalRows} valid, total ${formatUnits(BigInt(report.totalPayableWei), 18)} MUSD`);
  if (report.validRows !== 10) throw new Error("CSV validation failed");
  const bad = await A.call<{ invalidRows: number; duplicateWallets: number }>("POST", "/api/csv/validate", { csv: csv + `\nDup,d@example.com,${walletB.address},5,dup,Ops\nBad,b@example.com,0x123,abc,bad,Ops` });
  console.log(`  bad-file check: ${bad.invalidRows} invalid rows, ${bad.duplicateWallets} duplicate wallet(s) flagged`);
  const recCsv = ["name,email,wallet_address,department,external_id,payment_category,payment_frequency", ...people.map((p, i) => `${p.name},${p.email},${p.wallet},${p.dept},E${100 + i},salary,monthly`)].join("\n");
  await A.call("POST", `/api/orgs/${org.id}/recipients/import`, { csv: recCsv });

  // ---- run ----
  console.log("3. Create payroll run → on-chain");
  const run = await A.call<{ id: string }>("POST", `/api/orgs/${org.id}/runs`, {
    name: "November payroll", paymentCategory: "salary", frequency: "monthly", claimWindowDays: 30,
    items: people.map((p) => ({ name: p.name, email: p.email, department: p.dept, walletAddress: p.wallet, amount: p.amount, description: "November payroll" })),
  });
  const runPath = `/api/orgs/${org.id}/runs/${run.id}`;
  type Plan = { runRef: Hex; chainRunId: string | null; claimWindowSeconds: number; batches: { expectedIndex: number; recipients: Address[]; amounts: string[] }[]; expectedPaymentsHash: Hex | null; allocatedWei: string };
  let plan = await A.call<Plan>("GET", `${runPath}/plan`);
  let h = await send(employer, "createRun", { address: contracts.escrow, abi: payrollEscrowAbi, functionName: "createRun", args: [BigInt(confirmed.chainOrgId), plan.runRef, plan.claimWindowSeconds] });
  await A.call("POST", `${runPath}/tx`, { action: "create", txHash: h });
  plan = await A.call<Plan>("GET", `${runPath}/plan`);
  const chainRunId = BigInt(plan.chainRunId!);
  for (const [i, b] of plan.batches.entries()) {
    h = await send(employer, `addPayments#${i}`, { address: contracts.escrow, abi: payrollEscrowAbi, functionName: "addPayments", args: [chainRunId, b.expectedIndex, b.recipients, b.amounts.map(BigInt)] });
    await A.call("POST", `${runPath}/tx`, { action: "allocate", txHash: h });
  }
  h = await send(employer, "submitForApproval", { address: contracts.escrow, abi: payrollEscrowAbi, functionName: "submitForApproval", args: [chainRunId] });
  await A.call("POST", `${runPath}/tx`, { action: "submit", txHash: h });

  console.log("4. Approve (hash-bound) → fund with MUSD → publish");
  plan = await A.call<Plan>("GET", `${runPath}/plan`);
  const onchain = await pub.readContract({ address: contracts.escrow, abi: payrollEscrowAbi, functionName: "getRun", args: [chainRunId] });
  if (onchain.paymentsHash !== plan.expectedPaymentsHash) throw new Error(`hash mismatch ${onchain.paymentsHash} vs ${plan.expectedPaymentsHash}`);
  h = await send(employer, "approve", { address: contracts.escrow, abi: payrollEscrowAbi, functionName: "approve", args: [chainRunId, onchain.paymentsHash] });
  await A.call("POST", `${runPath}/tx`, { action: "approve", txHash: h });
  await send(employer, "MUSD.approve", { address: contracts.musd, abi: erc20Abi, functionName: "approve", args: [contracts.escrow, onchain.allocated] });
  h = await send(employer, "fund", { address: contracts.escrow, abi: payrollEscrowAbi, functionName: "fund", args: [chainRunId] });
  await A.call("POST", `${runPath}/tx`, { action: "fund", txHash: h });
  h = await send(employer, "publish", { address: contracts.escrow, abi: payrollEscrowAbi, functionName: "publish", args: [chainRunId] });
  await A.call("POST", `${runPath}/tx`, { action: "publish", txHash: h });

  // ---- recipients claim from their own wallets ----
  console.log("5. Recipients B and C claim from their own wallets");
  for (const [label, acct] of [["B", walletB], ["C", walletC]] as const) {
    const gas = await pub.getBalance({ address: acct.address });
    const need = (await pub.getGasPrice()) * 600_000n; // ~4 claims of headroom at the live gas price
    if (gas < need) await send(employer, `gas→${label}`, { to: acct.address, value: need > parseEther("0.00001") ? need : parseEther("0.00001") });
  }
  const detail = await A.call<{ items: { recipientAddress: string; paymentId: string }[] }>("GET", runPath);
  const pidOf = (a: Address) => BigInt(detail.items.find((i) => i.recipientAddress.toLowerCase() === a.toLowerCase())!.paymentId);

  // negative check: C tries to claim B's payment (simulated; must revert NotRecipient)
  try {
    await pub.simulateContract({ account: walletC, address: contracts.escrow, abi: payrollEscrowAbi, functionName: "claim", args: [pidOf(walletB.address)] });
    throw new Error("foreign claim did NOT revert");
  } catch (e) {
    if ((e as Error).message.includes("did NOT")) throw e;
    console.log("  ✓ wallet C cannot claim wallet B's payment (NotRecipient)");
  }

  const claimed: Record<string, unknown> = {};
  for (const [label, acct] of [["B", walletB], ["C", walletC]] as const) {
    const api = new Api(acct);
    await api.signIn();
    const pid = pidOf(acct.address);
    const info = await api.call<{ amount: string; status: string; description: string | null }>("GET", `/api/claims/${pid}`);
    const before = await pub.readContract({ address: contracts.musd, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] });
    h = await send(acct, `claim(${label})`, { address: contracts.escrow, abi: payrollEscrowAbi, functionName: "claim", args: [pid] });
    await api.call("POST", `/api/claims/${pid}/confirm`, { txHash: h });
    const after = await pub.readContract({ address: contracts.musd, abi: erc20Abi, functionName: "balanceOf", args: [acct.address] });
    if (after - before !== BigInt(info.amount)) throw new Error(`${label} received ${after - before}, expected ${info.amount}`);
    claimed[label] = { paymentId: pid.toString(), amount: formatUnits(BigInt(info.amount), 18), status: info.status, sawDescription: info.description !== null };
    const mine = await api.call<{ totalReceivedWei: string }>("GET", "/api/me/payments");
    console.log(`  ${label} received ${formatUnits(after - before, 18)} MUSD; dashboard total ${formatUnits(BigInt(mine.totalReceivedWei), 18)}`);
    try {
      await pub.simulateContract({ account: acct, address: contracts.escrow, abi: payrollEscrowAbi, functionName: "claim", args: [pid] });
      throw new Error("double claim did NOT revert");
    } catch (e) {
      if ((e as Error).message.includes("did NOT")) throw e;
    }
  }
  log.claims = claimed;
  console.log("  ✓ second claim attempts revert");

  // ---- reconciliation ----
  console.log("6. Reconciliation vs live contract state");
  await A.call("POST", `${runPath}/sync`);
  const rec = await A.call<{ allMatch: boolean; rows: { chainRunId: string | null; matches: boolean; chain: { claimedWei: string; outstandingWei: string } | null }[] }>("GET", `/api/orgs/${org.id}/reconciliation`);
  const row = rec.rows.find((r) => r.chainRunId === chainRunId.toString())!;
  const r2 = await pub.readContract({ address: contracts.escrow, abi: payrollEscrowAbi, functionName: "getRun", args: [chainRunId] });
  console.log(`  chain: funded ${formatUnits(r2.funded, 18)} · claimed ${formatUnits(r2.claimed, 18)} · outstanding ${formatUnits(r2.allocated - r2.claimed, 18)} MUSD`);
  console.log(`  report row matches chain: ${row.matches} · all runs match: ${rec.allMatch}`);
  if (!row.matches) throw new Error("reconciliation mismatch");
  const exportCsv = await A.call<string>("GET", `${runPath}/export`);
  writeFileSync(`${OUT}-report.csv`, exportCsv);
  const refundable = await pub.readContract({ address: contracts.escrow, abi: payrollEscrowAbi, functionName: "refundable", args: [chainRunId] });
  console.log(`  employer refundable while published: ${refundable} (must be 0)`);
  if (refundable !== 0n) throw new Error("refundable should be 0");

  log.run = { id: run.id, chainRunId: chainRunId.toString(), funded: formatUnits(r2.funded, 18), claimed: formatUnits(r2.claimed, 18), claimedCount: r2.claimedCount, paymentCount: r2.paymentCount };
  log.reconciliation = { rowMatches: row.matches, allMatch: rec.allMatch };
  log.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT}.json`, JSON.stringify(log, null, 2));
  console.log(`\nDone. Claim page: ${APP}/claim/${pidOf(others[0])}  ·  log: ${OUT}.json`);
}

main().catch((e) => {
  writeFileSync(`${OUT}.failed.json`, JSON.stringify({ ...log, error: String(e) }, null, 2));
  console.error(e);
  process.exit(1);
});
