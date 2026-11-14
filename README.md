# PayFlow

Payroll without borders. Payments powered by MUSD.

PayFlow lets a business, DAO or agency pay many people in MUSD on Mezo. Upload a spreadsheet, check it,
approve it, fund one escrow, and every recipient claims their own payment with their own wallet.
Every payment is recorded on-chain and reconciled against contract state.

## How it works

1. Create an organization (on-chain identity + roles: owner, admin, approver, operator).
2. Upload a payroll CSV. Every row is validated; nothing is dropped silently.
3. Put the run on-chain in batches; an approver signs off on the exact list (hash-bound).
4. Fund the escrow with MUSD (permit or approve), then publish.
5. Recipients open their claim link and claim with the designated wallet.
6. Track claims, export reports, reconcile against the contract. Unclaimed money returns to the funder only after the claim window.

## Repo

| Path | What |
|---|---|
| `contracts/` | Foundry: `OrganizationRegistry`, `PayrollEscrow`, 82 tests incl. audit regressions + invariants, `Deploy.s.sol` |
| `app/`, `components/`, `hooks/` | Next.js 16 app (landing, workspace, payroll wizard, claim page, recipient dashboard, reports) |
| `app/api/`, `lib/server/` | API: wallet sign-in, orgs, recipients, CSV, runs, tx verification, indexer, reports |
| `worker/` | Long-running indexer, recurring drafts, reminders, email outbox |
| `lib/chain/` | Chain config, ABIs, payments-hash commitment |
| `scripts/demo-testnet.ts` | Full multi-wallet demo against a running app |

## Run locally

```bash
npm install
cp .env.example .env.local        # add contract addresses once deployed
npm run dev                       # http://localhost:3000 (embedded PGlite DB if DATABASE_URL is empty)
npm run worker                    # optional: indexer + schedules + notifications
npx vitest run                    # 196 tests (incl. 11 against a local anvil chain)
cd contracts && forge test        # 82 contract tests incl. audit regressions + invariants
```

Without deployed addresses, the app runs with chain actions disabled and a banner.

## Docs

[Technical discovery](docs/TECHNICAL_DISCOVERY.md) · [Architecture](docs/ARCHITECTURE.md) · [Mezo integration](docs/MEZO_INTEGRATION.md) ·
[Contracts](docs/CONTRACTS.md) · [Payment accounting](docs/PAYMENT_ACCOUNTING.md) · [CSV format](docs/CSV_FORMAT.md) ·
[Security](docs/SECURITY.md) · [Privacy](docs/PRIVACY.md) · [Testing](docs/TESTING.md) · [Deployment](docs/DEPLOYMENT.md) ·
[Product strategy](docs/PRODUCT_STRATEGY.md) · [Demo script](docs/DEMO_SCRIPT.md) · [Roadmap](docs/ROADMAP.md)

On-chain amounts and wallet addresses are public. PayFlow is not confidential payroll; see [Privacy](docs/PRIVACY.md).
