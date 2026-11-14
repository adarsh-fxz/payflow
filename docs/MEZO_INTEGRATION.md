# Mezo integration

| What | Where |
|---|---|
| Wallet connection | **Mezo Passport** (`@mezo-org/passport`, `lib/client/wagmi.ts`): Bitcoin wallets (Unisat, OKX, Xverse) act through a Mezo smart account; Ethereum wallets connect directly |
| Chain config (31611, RPC, explorer, BTC gas) | `lib/chain/config.ts` (the only place addresses live) |
| MUSD `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` | verified on-chain: "Mezo USD", 18 decimals, EIP-2612. The deploy script refuses any other MUSD on 31611 |
| Balance reads | funding step (MUSD balance vs required), recipient dashboard, demo script |
| Approvals | `MUSD.approve(escrow, allocated)` + `fund`, or one EIP-2612 signature + `fundWithPermit` (Ethereum wallets only: MUSD's permit needs an ECDSA signature, so Passport smart accounts always use approve + fund) |
| Escrow deposit | `PayrollEscrow.fund` pulls exactly the approved total |
| On-chain allocations | `addPayments` (≤100 per tx), one record per payment |
| Claims / withdrawals | `claim` / `claimMany` send MUSD from escrow to the recipient's wallet |
| Verification | server checks every tx receipt + events; the claim page reads `getPayment`/`getRun` live; reports compare DB vs `getRun` |
| Explorer links | every tx hash and contract address in the UI links to explorer.test.mezo.org |

## Mezo Passport notes

- Passport 0.17 needs wagmi 2 and RainbowKit 2. Its package declares React 18 peers for its UI kit; PayFlow only loads
  the wagmi config module (`@mezo-org/passport/dist/src/config`), which works on React 19. `.npmrc` sets
  `legacy-peer-deps=true` so installs (and Vercel) accept that.
- `@coinbase/cdp-sdk` (pulled in by wagmi's connectors) lazily imports x402 packages PayFlow never uses; `next.config.ts`
  aliases them to `lib/stubs/empty-module.js`.
- Sign-in from a smart account: the server tries ECDSA recovery, then `publicClient.verifyMessage` (ERC-1271, or ERC-6492
  before the account is deployed). Covered by `tests/server/smart-account-signin.test.ts` with a mocked chain. **Not yet
  tried with a real Bitcoin wallet**; do that once on the deployed app.
- Claims and every other write are ordinary contract calls, so they work from a smart account. The claim must come from the
  address in the CSV, so a recipient using a Bitcoin wallet must give their Passport (smart account) address.

## Gas (BTC)

The funding step shows the wallet's BTC balance and a gas estimate (`estimateContractGas` × current gas price) before signing.
On testnet, gas is about 146 wei, so a 100-person run costs well under 0.00001 BTC in total. Recipients need a tiny amount of BTC
to claim; the testnet faucet is faucet.test.mezo.org.

## Getting testnet MUSD

Borrow MUSD against testnet BTC at testnet.mezo.org (a minimum loan size applies), or receive it from another wallet.

## Not used, on purpose

- Permit2: EIP-2612 on MUSD already gives one-signature funding.
- Other MUSD-labelled tokens on the explorer: not the official token.
- Mainnet addresses: none in the code. Mainnet needs a separate config and an audit first.
