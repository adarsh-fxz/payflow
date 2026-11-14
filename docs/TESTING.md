# Testing

## Suites

| Suite | Command | Count | Real or mocked |
|---|---|---|---|
| Contracts (unit + fuzz) | `cd contracts && forge test` | 59 | real EVM |
| Contract audit regressions | (included) `AuditRegressions.t.sol` | 19 | real EVM; each is a reproduced attack that must now fail |
| Contract invariants | (included) | 4 × 128 runs × 64 calls | handler: multi-batch runs with draft cancels, single and `claimMany` claims, foreign claims, funded/unfunded cancels, pause toggling, expiry, refunds incl. from the wrong org |
| Server + CSV | `npx vitest run tests/server tests/csv` | see below | real PGlite; synthetic logs for the indexer unit tests |
| Chain integration | (included) `tests/server/chain/` | 11 | **real anvil (chain 31611) + deployed contracts + PGlite**: org confirm, members + replay guard, full run lifecycle from real receipts, claim confirm + description privacy, sync of direct on-chain claims, wallet-redirect block, revoked approver, permissionless expiry, org recovery, auto-activation |
| UI | `npx vitest run tests/ui` | see below | pure logic: error decoding, wizard gating, invalid-email handling, status wording, mismatch gating |
| Types / lint / build | `npx tsc --noEmit`, `npx eslint .`, `npx next build` | | all clean |

`npx vitest run` runs all 196 off-chain and anvil tests (22 files) (the chain suite skips with a message if `anvil` isn't installed).

## Independent audit (Nov 2026)

Three reviewers who hadn't written the code audited it: contracts with mutation testing, backend with fault injection on a Mezo fork, and the UI in a real browser with an injected wallet. Findings and fixes:

| Finding | Fix | Proof |
|---|---|---|
| Admin could mint approvers and approve their own run | Only the owner manages ADMIN/APPROVER | `test_adminCannotMintApprovers`; the auditor's original exploit test now fails |
| Revoked approver still counted | Valid approvers re-counted at approve and fund | `test_revokedApprovalBlocksFunding`, `test_revokedApproverNotCountedAtApproval`, chain test "revoked approver" |
| Funded run's list could be changed before publish | Per-payment cancel is draft-only | `test_fundedRunListIsFrozen` |
| Operator could redirect a payment on-chain while the approver saw the reviewed name | Reviewed items immutable, chain values stored separately, mismatch blocks the run (409) | chain test "B1", `lifecycle.test.ts` |
| Lost or out-of-order notifications | Emitted on event insertion; reminders only after "available" | `lifecycle.test.ts` |
| Production build failed | Script typed; configs exclude non-app paths | `next build` |
| Wizard dropped invalid emails | Raw cell kept and flagged | `remediation.test.ts` |
| Lost confirm created duplicate on-chain orgs | `POST /orgs/:id/recover` plus worker auto-activation; UI recovers first | chain tests "recover", "auto-activates" |
| Mobile tables hid amount/status | Stacked layouts | browser screenshots |
| Unauthenticated slow claim-confirm, spoofable XFF, header-derived sign-in domain, hidden RPC outages | One receipt lookup with no polling, per-IP + per-payment limits, platform IP, APP_URL in production, 503 `chain_unavailable` | `hardening.test.ts`, `outage.test.ts` |
| Mutations that survived (receipt `to` check, claim description privacy, member replay guard, expire at deadline, ex-owner roles) | New tests | all killed on re-run |

## solidity-auditor scan (12 Nov 2026)

Two passes of the Pashov `solidity-auditor` skill (12 agents per pass) over `PayrollEscrow`, `OrganizationRegistry` and
`Deploy.s.sol`. It found no theft path. Four findings and one lead were fixed; each new test fails on the old contract.

| Finding | Fix | Proof |
|---|---|---|
| Approvers didn't sign the claim window, so an operator could set 1 hour | The window seeds `paymentsHash`; the app builds the hash from the reviewed window; the indexer keeps the reviewed window and blocks the run if the chain differs | `test_claimWindowIsPartOfApprovedHash`, `claim-window.test.ts`, chain suite (app hash = contract hash) |
| An operator could cancel an approved run | Cancelling an Approved run needs ADMIN | `test_operatorCannotCancelApprovedRun`, `remediation.test.ts` |
| One operator or approver could reset an Approved run before every fund call | Approved → Draft needs ADMIN (pending runs can still be sent back by operators/approvers) | `test_singleHolderCannotUnapprove`, `roles.test.ts` |
| Refund needed an admin although it only pays the funder | `refund` is open to anyone and still pays only `run.funder`; live runs have nothing refundable | `test_funderRecoversWithoutAdmin`, `test_openRefundCannotTouchLiveRuns` |
| Lead: the registry was accepted as a recipient | Rejected in `addPayments` (the CSV check already blocked it) | `test_registryRejectedAsRecipient` |

The remaining leads (uint8 approval counter at 256 approvers, MUSD pause dependency, deploy-script checks off chain
31611, approval-threshold snapshot, and others) are in the local scan report (`.solidity-auditor/runs/20261112-164653/full-report.md`, not committed) and were
left as they are: each needs the owner acting against itself or is intended behaviour.

## End to end

`scripts/demo-testnet.ts` drives the real API and real transactions with an employer and two recipient wallets. It covers:
- org creation;
- CSV validation, including a broken file;
- the on-chain run, hash-bound approval, MUSD funding and publishing;
- C refused on B's payment, B and C claiming with balances checked, second claims refused;
- reconciliation against `getRun()`, and refundable = 0 while published.

**Passed on a Mezo Testnet fork (real MUSD contract) on 9 Nov 2026, against the post-audit production build.**

A second independent browser pass re-ran every journey through the real UI, backend, worker and fork (no mocking): wrong-network connect, org + roles, CSV import, the 12-row wizard with an invalid email, two-approver approval, approver revocation blocking funding, permit funding, the publish dialog, wrong-wallet refusal, claims, an on-chain wallet-redirect attempt (blocked), expiry + refund, org recovery after an aborted confirm, a 33 s RPC outage, reports vs `getRun`, notification order, and 390 px mobile. The issues it found (token address accepted as a recipient, claim screen asking to sign in, no non-member expiry path, no auto-recovery after an outage, stale copy) were fixed in 7f2ffca and are covered by tests. That second pass was not repeated after those fixes. It has not been run on the live testnet; that needs the deployment (see DEPLOYMENT.md).
