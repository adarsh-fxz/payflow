// FROZEN. Single source of chain + contract configuration. Never hardcode addresses elsewhere.
import { defineChain, type Address } from "viem";

export const MEZO_TESTNET_ID = 31611 as const;

export const mezoTestnet = defineChain({
  id: MEZO_TESTNET_ID,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_MEZO_RPC_URL || "https://rpc.test.mezo.org"],
      webSocket: ["wss://rpc-ws.test.mezo.org"],
    },
  },
  blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.test.mezo.org" } },
  testnet: true,
});

/** Verified 2026-11-09 on chain 31611: name "Mezo USD", symbol MUSD, 18 decimals, EIP-2612 permit
 *  (EIP-712 domain "Mezo USD" / "1"). Listed in the official Mezo contracts reference. */
export const MUSD_TESTNET: Address = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
export const MUSD_DECIMALS = 18 as const;
export const MUSD_SYMBOL = "MUSD" as const;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function addr(v: string | undefined): Address {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : ZERO;
}

/** Deployed PayFlow contracts. Filled from env after `forge script Deploy`. */
export const contracts = {
  musd: addr(process.env.NEXT_PUBLIC_MUSD_ADDRESS) === ZERO ? MUSD_TESTNET : addr(process.env.NEXT_PUBLIC_MUSD_ADDRESS),
  escrow: addr(process.env.NEXT_PUBLIC_ESCROW_ADDRESS),
  registry: addr(process.env.NEXT_PUBLIC_REGISTRY_ADDRESS),
  /** Block the contracts were deployed at; the indexer starts here. */
  deployBlock: BigInt(process.env.NEXT_PUBLIC_DEPLOY_BLOCK || "0"),
} as const;

export const isDeployed = contracts.escrow !== ZERO && contracts.registry !== ZERO;

export const explorerTx = (hash: string) => `https://explorer.test.mezo.org/tx/${hash}`;
export const explorerAddress = (a: string) => `https://explorer.test.mezo.org/address/${a}`;

/** Role bits — must match OrganizationRegistry. Owner implicitly holds all. */
export const ROLE = { ADMIN: 1, APPROVER: 2, OPERATOR: 4 } as const;
export const ALL_ROLES = 7;

/** Must match PayrollEscrow constants. */
export const ESCROW_LIMITS = {
  MAX_BATCH: 100,
  MAX_CLAIM_BATCH: 50,
  MAX_PAYMENTS_PER_RUN: 5000,
  MIN_CLAIM_WINDOW: 3600,
  MAX_CLAIM_WINDOW: 365 * 24 * 3600,
} as const;

/** On-chain enum order (IPayrollEscrow.RunStatus / PaymentStatus). */
export const CHAIN_RUN_STATUS = ["none", "draft", "pending_approval", "approved", "funded", "published", "cancelled", "expired"] as const;
export const CHAIN_PAYMENT_STATUS = ["none", "allocated", "claimed", "cancelled"] as const;

/** paymentId = (runId << 32) | index */
export const paymentIdOf = (runId: bigint, index: number) => (runId << 32n) | BigInt(index);
export const splitPaymentId = (pid: bigint) => ({ runId: pid >> 32n, index: Number(pid & 0xffffffffn) });
