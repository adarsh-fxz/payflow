# Deployment

## Status (9 Nov 2026)

| Piece | Status |
|---|---|
| Contracts on Mezo Testnet | **Not deployed yet.** Waiting for a funded deployer key in `contracts/.env` |
| Full flow on a Mezo Testnet fork (real MUSD) | Passed (see TESTING.md) |
| Frontend (Vercel) | Not deployed. Needs the owner's Vercel account |
| Worker (Render) | Not deployed. `render.yaml` is ready |
| Postgres | Not provisioned. Needs a Neon/Supabase `DATABASE_URL` |

## Network

Mezo Testnet, chain 31611, RPC `https://rpc.test.mezo.org`, explorer `https://explorer.test.mezo.org`.
MUSD `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`.

## Contract addresses

| Contract | Address | Deploy tx |
|---|---|---|
| OrganizationRegistry | _pending_ | |
| PayrollEscrow | _pending_ | |

## Current testnet deployment (13 Nov 2026)

| Contract | Address |
|---|---|
| PayrollEscrow | [`0xEA33984C418332d65732b550c0BC9eEb5CF581A7`](https://explorer.test.mezo.org/address/0xEA33984C418332d65732b550c0BC9eEb5CF581A7) |
| OrganizationRegistry | [`0xb2dB4063caD9A1236C87cb1070d605484643C1b3`](https://explorer.test.mezo.org/address/0xb2dB4063caD9A1236C87cb1070d605484643C1b3) |
| MUSD (Mezo) | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/address/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) |

Deploy block `16751853` (`NEXT_PUBLIC_DEPLOY_BLOCK`). Includes the solidity-auditor fixes (commit 8826ea3). Full record: `contracts/deployments/31611.json`.

Database: Supabase, schema `payflow` (`DATABASE_SCHEMA=payflow`), through the **session pooler** (`aws-1-ap-northeast-2.pooler.supabase.com:5432`, user `postgres.<project-ref>`). The direct `db.<ref>.supabase.co` host is IPv6 only. The project is shared with other apps, so keep `DATABASE_SCHEMA` set everywhere the app or worker runs.

## Steps

```bash
# 1. contracts
cd contracts
cp .env.example .env            # DEPLOYER_PRIVATE_KEY=0x…  (wallet with testnet BTC)
forge test
forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --legacy
cat deployments/31611.json      # registry, escrow, block

# 2. app env (.env.local for dev, Vercel/Render env for prod) — see .env.example
NEXT_PUBLIC_ESCROW_ADDRESS=…  NEXT_PUBLIC_REGISTRY_ADDRESS=…  NEXT_PUBLIC_DEPLOY_BLOCK=…
DATABASE_URL=postgres://…     DATABASE_SCHEMA=payflow   # shared DB only
SESSION_SECRET=…  INDEXER_SECRET=…
NEXT_PUBLIC_APP_URL=https://…   # REQUIRED in production: sign-in is refused without it

# 3. database
npm run db:migrate

# 4. frontend: Vercel, framework Next.js, root = repo root, env from step 2
# 5. worker: Render blueprint (render.yaml) with the same env → `npm run worker`
#    (fallback without a worker: call POST /api/indexer/sync with Bearer INDEXER_SECRET on a schedule)

# 6. live demo
APP_URL=https://<app> npx tsx scripts/demo-testnet.ts
```

## Testnet transactions

_Filled in from `contracts/deployments/demo-31611.json` after the live run._
