/**
 * Local anvil chain for chain-backed integration tests: starts anvil (chain id 31611, random port),
 * deploys MockMUSD + OrganizationRegistry + PayrollEscrow from contracts/out, and exposes wallet
 * helpers. The suite is skipped (with a message) only when anvil is not installed.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const ROOT = path.resolve(__dirname, "../../..");
const CONTRACTS = path.join(ROOT, "contracts");

export function findFoundryBin(name: "anvil" | "forge"): string | null {
  const home = path.join(os.homedir(), ".foundry", "bin", name);
  if (fs.existsSync(home)) return home;
  const w = spawnSync("which", [name], { encoding: "utf8" });
  return w.status === 0 && w.stdout.trim() ? w.stdout.trim() : null;
}

/** Well-known public test keys (several are anvil defaults); every one is funded via anvil_setBalance. Never use on a real network. */
export const KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  approver: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  admin: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a8e4ab5c1aa1",
  alice: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  bob: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  stranger: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const satisfies Record<string, Hex>;
export type Who = keyof typeof KEYS;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

interface Artifact { abi: Abi; bytecode: { object: Hex } }
function artifact(file: string, name: string): Artifact {
  const p = path.join(CONTRACTS, "out", file, `${name}.json`);
  if (!fs.existsSync(p)) {
    const forge = findFoundryBin("forge");
    if (!forge) throw new Error(`Missing ${p} and forge is not installed`);
    const r = spawnSync(forge, ["build"], { cwd: CONTRACTS, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`forge build failed: ${r.stderr}`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8")) as Artifact;
}

export interface LocalChain {
  rpcUrl: string;
  pub: PublicClient;
  musd: Address;
  registry: Address;
  escrow: Address;
  deployBlock: bigint;
  account(who: Who): PrivateKeyAccount;
  /** Sends a contract write as `who`, waits for the receipt (status must be success), returns the hash. */
  write(who: Who, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hex>;
  /** Simulates a write; resolves to the revert error name or null when it would succeed. */
  revertOf(who: Who, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<string | null>;
  increaseTime(seconds: number): Promise<void>;
  stop(): Promise<void>;
}

export async function startChain(): Promise<LocalChain> {
  const anvilBin = findFoundryBin("anvil");
  if (!anvilBin) throw new Error("anvil not installed");
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(anvilBin, ["--chain-id", "31611", "--port", String(port), "--silent"], { stdio: "ignore" });
  const chain = defineChain({ id: 31611, name: "anvil-31611", nativeCurrency: { name: "BTC", symbol: "BTC", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await pub.getBlockNumber({ cacheTime: 0 });
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const account = (who: Who) => privateKeyToAccount(KEYS[who]);
  const wallet = (who: Who) => createWalletClient({ account: account(who), chain, transport: http(rpcUrl) });
  for (const who of Object.keys(KEYS) as Who[]) {
    await pub.request({ method: "anvil_setBalance" as never, params: [account(who).address, "0x56BC75E2D63100000"] as never }); // 100 BTC for gas
  }

  async function deploy(a: Artifact, args: unknown[]): Promise<Address> {
    const hash = await wallet("owner").deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  }
  const musdArt = artifact("MockMUSD.sol", "MockMUSD");
  const regArt = artifact("OrganizationRegistry.sol", "OrganizationRegistry");
  const escArt = artifact("PayrollEscrow.sol", "PayrollEscrow");
  const deployBlock = await pub.getBlockNumber({ cacheTime: 0 });
  const musd = await deploy(musdArt, []);
  const registry = await deploy(regArt, []);
  const escrow = await deploy(escArt, [musd, registry, account("owner").address]);

  return {
    rpcUrl, pub, musd, registry, escrow, deployBlock, account,
    async write(who, address, abi, functionName, args) {
      const hash = await wallet(who).writeContract({ address, abi, functionName, args, chain, account: account(who) } as never);
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error(`${functionName} reverted`);
      return hash;
    },
    async revertOf(who, address, abi, functionName, args) {
      try {
        await pub.simulateContract({ address, abi, functionName, args, account: account(who) } as never);
        return null;
      } catch (e) {
        const m = String((e as Error).message);
        const name = /reverted with the following reason:\s*\n?\s*([A-Za-z]+)/.exec(m)?.[1] ?? /error\s+"?([A-Z][A-Za-z]+)\(/.exec(m)?.[1] ?? /([A-Z][A-Za-z]+)\(/.exec(m)?.[1];
        return name ?? m.slice(0, 200);
      }
    },
    async increaseTime(seconds) {
      await pub.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
      await pub.request({ method: "evm_mine" as never, params: [] as never });
    },
    async stop() {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
