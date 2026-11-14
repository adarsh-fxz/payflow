# Demo script

About 6 minutes. You need three browser profiles or wallets: **A** (employer: BTC for gas + MUSD), **B** and **C** (recipients, a little BTC each).

## Automated version

```bash
npm run dev                                   # app with deployed addresses in .env.local
APP_URL=http://localhost:3000 npx tsx scripts/demo-testnet.ts
```
This runs everything below with real testnet transactions and writes every tx hash to `contracts/deployments/demo-31611.json`.

## Live walkthrough

**Employer (wallet A)**
1. Open PayFlow → *Create an organization* → connect A → sign in (one signature, no gas).
2. Name the org → *Create* → confirm the registry transaction. The org is now on Mezo.
3. Recipients → *Import CSV*: upload the 10-person file. Show one wrong wallet and one duplicate being flagged, fix them inline.
4. Payroll → *New run* → Salary → upload the payroll CSV → validation summary ("10 valid · total 32.5 MUSD") → review → *Save draft*.
5. *Put on-chain*: createRun, addPayments ("batch 1 of 1"), submit for approval.
6. *Approve*: the page shows the list and says the on-chain fingerprint matches → approve tx.
7. *Fund*: shows MUSD balance, required MUSD, BTC gas estimate → sign permit → fund. Escrow now holds 32.5 MUSD.
8. *Publish* → claims open. The run page shows 10 outstanding and a claim link per person.

**Recipient (wallet B)**
9. Open B's claim link → org, amount, reference → *Connect wallet & claim payment*.
10. First connect wallet C on B's link: the page says it isn't the designated wallet and offers no claim button.
11. Switch to B → claim → success screen with the amount and explorer link. *My payments* shows the total received.

**Reconciliation (wallet A)**
12. Back on the run: 1 claimed, outstanding drops. Reports → reconciliation shows DB vs chain with a match on every run.
13. *Export CSV*. Open the escrow on the explorer and compare `getRun` to the report.
14. Try *Refund* on the published run: there's nothing to refund, because the money belongs to recipients until the claim window ends.
