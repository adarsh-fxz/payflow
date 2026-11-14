# Contracts

Solidity 0.8.28, OpenZeppelin 5.4, Foundry. Source: `contracts/src`. Interfaces (frozen): `contracts/src/interfaces`.

## OrganizationRegistry

Holds no funds. Stores per org: `owner`, `pendingOwner`, `approvalsRequired` (1–10), `createdAt`, `metadataHash`
(commitment to the off-chain profile), and a role bitmask per member.

| Role bit | Name | Can |
|---|---|---|
| 1 | ADMIN | fund, publish, cancel approved or funded runs (funded → full refund), send an approved run back to draft; grant/remove OPERATOR only; update metadata |
| 2 | APPROVER | approve a pending run; send a pending run back to draft |
| 4 | OPERATOR | create runs, add payments, cancel draft payments, submit for approval, send a pending run back to draft, cancel draft or pending runs |
| — | Owner | everything; **only the owner grants or removes ADMIN and APPROVER**, changes the approval threshold and transfers ownership (two-step; `address(0)` cancels a pending transfer) |

Approvers are owner-controlled so an admin can't create the approvals that gate their own runs (fixed after the Nov 2026 audit).

## PayrollEscrow

One contract for every org. Immutable `token` (MUSD) and `registry`. Platform `DEFAULT_ADMIN_ROLE` / `PAUSER_ROLE`
can pause **only** new activity (createRun, addPayments, submit, approve, fund, publish). Claims, cancels, expiry
and refunds keep working while paused, so money is never trapped. The platform admin cannot move funds.

### Functions

| Function | Who | Status before → after | Notes |
|---|---|---|---|
| `createRun(orgId, runRef, claimWindow)` | OPERATOR/ADMIN | – → Draft | `runRef` unique per org (idempotent creation). Window 1h–365d |
| `addPayments(runId, expectedIndex, recipients[], amounts[])` | OPERATOR/ADMIN | Draft | ≤100 per call; `expectedIndex == paymentCount` so replays revert; no zero address / escrow / MUSD token / registry / zero amount |
| `cancelPayment(paymentId)` | OPERATOR/ADMIN | Draft only | Once submitted, the approved list is frozen. Change a funded run by cancelling it whole |
| `submitForApproval(runId)` | OPERATOR/ADMIN | Draft → PendingApproval | Snapshots the org's `approvalsRequired` |
| `returnToDraft(runId)` | PendingApproval: OPERATOR/APPROVER/ADMIN. Approved: ADMIN | PendingApproval/Approved → Draft | Starts a new approval round. One operator or approver can't undo a reached threshold |
| `approve(runId, expectedPaymentsHash)` | APPROVER | PendingApproval → Approved at threshold | Hash must equal the on-chain commitment; one approval per wallet per round; only approvers who **still hold the role** count |
| `fund(runId)` / `fundWithPermit(...)` | ADMIN | Approved → Funded | Re-counts valid approvers (`ApprovalsRevoked` if a removed approver drops it below the threshold); pulls exactly `allocated`; sets `funder`; checks the received amount |
| `publish(runId)` | ADMIN | Funded → Published | `claimDeadline = now + claimWindow` |
| `claim(paymentId)` / `claimMany(ids)` | the payment's recipient | Published | Before or at the deadline; ≤50 per `claimMany` |
| `cancelRun(runId)` | Draft/PendingApproval: OPERATOR/ADMIN. Approved/Funded: ADMIN | Draft…Funded → Cancelled | Published runs can't be cancelled |
| `expireRun(runId)` | anyone | Published → Expired | Only after the deadline; it only makes unclaimed money refundable to the funder |
| `refund(runId)` | anyone | any | Sends `refundable(runId)` to `run.funder`, never to the caller. Zero while recipients are owed money |

### Payment ids and commitment

`paymentId = (runId << 32) | index`. `paymentsHash` starts at `keccak256(abi.encode(chainId, escrow, runId, claimWindow))` (so approvers sign the claim window too)
and folds every add `keccak256(abi.encode(h, paymentId, recipient, amount))` and every draft cancel
`keccak256(abi.encode(h, paymentId, address(0), 0))`. `lib/chain/commitment.ts` recomputes it off-chain.

### Why two contracts, not five

The brief suggested PaymentRegistry, ClaimManager and RoleManager as separate contracts. Payment records and
claims live inside `PayrollEscrow` because the claim must update the same ledger that holds the money. Splitting
them would add cross-contract calls and trust edges without isolating anything. Roles live in
`OrganizationRegistry`, which is the RoleManager.

### Events

`RunCreated, PaymentAllocated, PaymentCancelled, RunSubmitted, RunApproved, RunReturnedToDraft, RunFunded,
RunPublished, PaymentClaimed, RunCancelled, RunExpired, Refunded`, plus the registry's `OrganizationCreated,
MemberRolesSet, ApprovalsRequiredSet, OwnershipTransferStarted, OwnershipTransferred, MetadataUpdated`.
The indexer rebuilds all off-chain payment state from these.

## Tests

`cd contracts && forge test`. There are 82 tests: 50 escrow unit + fuzz, 9 registry, 19 audit regressions (`AuditRegressions.t.sol`, each a reproduced attack that must now fail) and 4 stateful invariants (128 runs × 64 depth; actors include multi-batch runs with draft cancels, `claimMany`, foreign claims, pause toggling, expiry and cross-org refunds).
Views added: `validApprovals(runId)`, `approversOf(runId)`.
See `docs/TESTING.md`.
