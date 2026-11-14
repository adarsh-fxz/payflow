# Technical discovery

Checked directly against Mezo Testnet on 9 Nov 2026 with `cast` (RPC `https://rpc.test.mezo.org`).

## Network

| Item | Value | How verified |
|---|---|---|
| Chain ID | 31611 | `cast chain-id` |
| RPC / WS | `https://rpc.test.mezo.org` / `wss://rpc-ws.test.mezo.org` | Mezo docs + live calls |
| Explorer | `https://explorer.test.mezo.org` (Blockscout, API `api.explorer.test.mezo.org/api/v2`) | |
| Gas token | BTC, 18 decimals | `eth_getBalance` |
| Block gas limit | 10,000,000 | `cast block latest` |
| Gas price | ~146 wei | `cast gas-price` |
| EVM | Supports PUSH0 / MCOPY / TSTORE (cancun). Contracts compile with `evm_version = cancun` | Probed in an earlier Mezo build; OZ 5.4 compiles and deploys |

## MUSD

| Item | Value |
|---|---|
| Address (testnet) | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` (in the official contracts reference) |
| name / symbol / decimals | "Mezo USD" / "MUSD" / 18 |
| Total supply (9 Nov 2026) | ~524.0M MUSD |
| EIP-2612 permit | Yes: `DOMAIN_SEPARATOR()`, `nonces(address)`, `eip712Domain()` → name "Mezo USD", version "1", chainId 31611 |
| Permit2 | Canonical Permit2 (`0x0000…22D4…8BA3`) has code on testnet. Not used: EIP-2612 already gives one-signature funding |
| Fee on transfer | None. The escrow still checks the received amount and reverts on shortfall |
| How a business gets MUSD | Borrow against BTC at testnet.mezo.org (minimum debt applies) or receive it; BTC for gas from the faucet |

Other "MUSD"-labelled contracts on the explorer were not used. The app reads the token address from
`lib/chain/config.ts` only, and the deploy script refuses any other MUSD address on chain 31611.

## Approval mechanism

- Standard `approve` + `PayrollEscrow.fund` always works.
- `fundWithPermit` takes an EIP-2612 signature for the exact run amount and funds in one tx. A front-run
  permit only uses up the nonce (the allowance still lands), so a failed `permit` call is ignored and the
  transfer decides.

## Distribution architecture

Chosen: **on-chain payment records** in batches of ≤100. This follows the owner's direction: prove escrow,
claims and accounting first, and do Merkle only after measuring gas.

Measured (Foundry gas report):

| Call | Gas |
|---|---|
| `createRun` | ~213k |
| `addPayments` (3 payments) | ~214k |
| `addPayments` (100 payments) | ~4.85M (≈48.5k per payment; fits the 10M block) |
| `submitForApproval` | ~53k |
| `approve` | ~47–69k |
| `fund` | ~133k |
| `publish` | ~51k |
| `claim` | ~86k |

At ~146 wei gas price, a 100-person payroll costs about 5.4M gas in total for the employer. Each recipient pays for their own claim.
A Merkle root would cut the employer side to O(1) and is on the roadmap. The claim side would stay about the same.

## Business workflow decisions

- Approval is on-chain (`approve(runId, paymentsHash)`), so the contract enforces the approver role and the
  exact list that was approved.
- Recurring payroll generates **drafts only**. Funding always needs a person to sign.
- Names, emails, departments and descriptions never go on-chain.
