# Product strategy

## Who it's for (first)

Crypto-native organizations that already hold or can borrow MUSD:

1. DAOs paying contributors every month
2. Web3 startups with remote teams
3. Dev agencies paying contractors
4. Bounty platforms and hackathon organizers
5. Grant programs

We don't claim to replace a payroll provider or bank transfers for every business. Tax withholding, payslips
and fiat rails are out of scope.

## The pain

- Payment lists live in spreadsheets, and someone sends 40 transfers by hand.
- Mistyped addresses and amounts are only noticed after the money moves.
- "Did you pay me?" messages, with no single place that shows who has and hasn't been paid.
- Monthly runs repeat the same manual work.
- Finance can't easily prove the books match what happened on-chain.

## What PayFlow does about it

| Pain | PayFlow |
|---|---|
| Spreadsheet → transfers | Upload a CSV, get a validation report (bad wallets, duplicates, decimals, totals) before anything is signed |
| Mistakes after the fact | Approver signs the exact on-chain list (hash-bound); admin can cancel a payment before publishing |
| Status confusion | Every payment has a claim link and a live status; employer sees claimed / outstanding per person |
| Repetition | Monthly templates create the next draft automatically; a person still approves and funds |
| Reconciliation | Reports compare indexed totals with live contract state per run; CSV export |

## Alternatives

| Alternative | Gap |
|---|---|
| Wallet multi-send / Safe batch | Sends money but no recipient directory, approval trail, claim status or reconciliation |
| Disperse-style contracts | Push payments: a wrong address loses money, and there's no escrow or expiry |
| Crypto payroll SaaS (custodial) | Custody and KYC overhead; often not on Mezo or MUSD |
| Spreadsheet + manual transfers | Everything above |

## Why MUSD

It's a dollar-denominated stable asset, so salaries stay predictable. Organizations holding BTC on Mezo can borrow MUSD against it
instead of selling BTC to make payroll. Recipients get a token they can hold, spend or repay with.

## Why Mezo

BTC-native holders are the natural payers. Gas is paid in BTC, fees are low (about 146 wei gas price on testnet), and MUSD is the
chain's native stablecoin, so payroll becomes a recurring, real-world use of MUSD rather than a one-off trade.

## Acquisition

- Hackathon and bounty organizers on Mezo: one run pays every winner, and each claim link doubles as a product demo.
- DAOs already holding MUSD: import last month's payment sheet and run it in PayFlow.
- Every recipient sees PayFlow when claiming, and recipients who run teams become payers.

## Revenue (future, not in the MVP)

| Tier | For | Includes |
|---|---|---|
| Free | small teams | limited recipients and runs, basic reports |
| Business | startups, agencies | more recipients, recurring templates, multi-approver, email notifications, members |
| Enterprise | platforms | API, custom roles, multi-org, audit exports |

Possible models: subscription, flat fee per run, or a small fee shown at funding time. **The MVP charges nothing**,
and the contracts have no fee path.

## Retention

Recurring templates, the recipient directory and payment history make PayFlow the system of record for who
was paid what, which is hard to leave once a few months are in.

## Differentiation

Escrow + pull claims, approval bound to the exact on-chain list, reconciliation against live contract state,
and a CSV-first workflow built for a finance person, not a crypto power user.
