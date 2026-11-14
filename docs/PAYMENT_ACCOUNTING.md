# Payment accounting

The escrow never treats its token balance as "available money". Every run keeps its own ledger.

## Per-run ledger (MUSD wei, `uint128`)

| Field | Meaning |
|---|---|
| `allocated` | Sum of payments that are not cancelled |
| `funded` | Amount pulled in by `fund` (always equals `allocated` at that moment) |
| `claimed` | Paid out to recipients |
| `refunded` | Returned to the funder |

Derived:

```
liability  = allocated − claimed      while Funded or Published, else 0
refundable = funded − claimed − refunded − liability
```

Which works out to:

| Status | Refundable |
|---|---|
| Draft / PendingApproval / Approved | 0 (nothing funded) |
| Funded | 0 (the approved list is frozen; cancel the whole run to get money back) |
| Published | 0. Every remaining unit is owed to a recipient |
| Cancelled (was funded) | everything not yet refunded |
| Expired | unclaimed amounts |

Global: `totalHeld = Σ (funded − claimed − refunded)`, and `token.balanceOf(escrow) ≥ totalHeld` always.

## Invariants and where they're enforced

| # | Invariant | Mechanism | Test |
|---|---|---|---|
| 1 | No double claim | payment status `Allocated → Claimed` before transfer; `nonReentrant` | `test_duplicateClaimReverts`, `invariant_claimSafety`, `test_reentrantTokenCannotDoubleClaim` |
| 2 | Only the designated wallet claims | `p.recipient == msg.sender`; funds go to `msg.sender` | `test_otherWalletCannotClaim`, `test_claimManyRejectsForeignPayment`, invariant |
| 3 | Allocation ≤ funded | fund pulls exactly `allocated`; adds only in Draft | `invariant_perRunAccounting` |
| 4 | No publish without funding | `publish` requires `Funded` | `test_publishRequiresFunding` |
| 5 | Employer can't withdraw owed funds | `refundable` excludes liability; no per-payment cancel once submitted; only a whole unpublished run can be cancelled | `test_employerCannotWithdrawAllocatedFunds`, `test_fundedRunListIsFrozen`, `test_cannotCancelPaymentAfterPublish` |
| 6 | Cancelled payment can't be claimed | status check | `test_draftCancelExcludedFromFunding` |
| 7 | Expired run can't be claimed | status `Expired` + deadline check | `test_expiryAndRefundOfUnclaimed`, `test_claimAfterDeadlineReverts` |
| 8 | Wallet can't change after publish | no reassign function exists; only adds in Draft | design |
| 9 | No double funding | status `Approved → Funded` set before transfer | `test_cannotFundTwice` |
| 10 | Claims ≤ allocated | per-payment status, sum tracked | fuzz + invariant |
| 11 | Orgs can't touch each other's funds | per-run ledgers; role checks per `run.orgId`; refunds to `run.funder` | `test_crossOrgIsolation`, invariant `refund(asOtherOrg)` |
| 12 | Replays don't duplicate | `runRef` unique per org; `addPayments(expectedIndex)` | `test_duplicateRunRefReverts`, `test_replayedBatchReverts` |
| – | Balance covers liabilities | `totalHeld` ghost-checked | `invariant_balanceCoversHeld` |
| – | Approved list = on-chain list | `approve(runId, paymentsHash)`; list frozen after submit | `test_approveRequiresMatchingHash`, `test_fundedRunListIsFrozen` |
| – | Approved claim window = on-chain window | window seeds `paymentsHash` | `test_claimWindowIsPartOfApprovedHash` |
| – | Refund needs no admin and pays only the funder | `refund` is open; destination is `run.funder` | `test_funderRecoversWithoutAdmin`, `test_openRefundCannotTouchLiveRuns` |
| – | Approvals come from current approvers | valid approvers re-counted at approve and fund; only the owner manages approvers | `test_adminCannotMintApprovers`, `test_revokedApprovalBlocksFunding`, `test_revokedApproverNotCountedAtApproval` |
| – | Liability = sum of claimable payments | per-payment status | `invariant_liabilityMatchesOpenPayments` |

## Off-chain reconciliation

The database stores indexed copies of `funded / claimed / refunded` per run and claim rows per payment. These come only from
contract events. The Reports page calls `getRun()` live for each on-chain run and shows DB vs chain
side by side, flagging any mismatch. The DB is never used as proof that something was paid.

## Scaling notes

On-chain records cost about 48.5k gas per payment. That is fine for hundreds of payments; 5,000 payments is about 50 batches.
For larger runs the next step is a Merkle root committed together with the total, the token, the run id and the funding amount,
with claims tracked in a bitmap (see ROADMAP.md). It was deliberately not built first.
