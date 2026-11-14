import type { Address } from "viem";
import { contracts, MEZO_TESTNET_ID } from "@/lib/chain/config";

/** MUSD EIP-712 domain, verified on chain 31611 (see lib/chain/config.ts). */
export const MUSD_PERMIT_DOMAIN = { name: "Mezo USD", version: "1" } as const;

export function permitTypedData(owner: Address, value: bigint, nonce: bigint, deadline: bigint) {
  return {
    domain: { ...MUSD_PERMIT_DOMAIN, chainId: MEZO_TESTNET_ID, verifyingContract: contracts.musd },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    message: { owner, spender: contracts.escrow, value, nonce, deadline },
  };
}

/** Permit deadline: 30 minutes from now, in seconds. */
export function permitDeadline(minutes = 30): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 60 * minutes);
}
