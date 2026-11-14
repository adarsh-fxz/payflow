# Security

No external audit has been done. This is a testnet MVP.

## Threat model (escrow)

| Asset | Threat | Control |
|---|---|---|
| Escrowed MUSD | Employer pulls back money owed to recipients | `refundable` excludes liability; nothing can be cancelled after publish; refunds go only to `run.funder` |
| | Platform operator takes funds | Platform admin can only pause new activity; there is no sweep or upgrade path (contracts aren't upgradeable) |
| | Another org drains this run | Ledgers are per run; every privileged call checks roles on `run.orgId` |
| | Reentrancy via the token | `nonReentrant` on fund/claim/claimMany/refund; state is updated before transfers; tested with a re-entering token |
| | Fee-on-transfer / short funding | Received amount is checked against `allocated`, and funding reverts on a shortfall |
| A recipient's payment | Someone else claims it | `msg.sender == recipient`; tokens are sent to `msg.sender`; changing the claim URL doesn't help |
| | Double claim | status flips to Claimed before the transfer |
| | Funds trapped by pause | claims, cancellations, expiry and refunds aren't pausable |
| The approved list | Changed between review and approval | `approve(runId, paymentsHash)` must match the on-chain commitment, which also covers the claim window; the app recomputes it from the reviewed run |
| | One role holder undoes an approval | Only an admin can send an Approved run back to draft or cancel it |
| Replays | Duplicate runs/allocations | unique `runRef` per org; `addPayments(expectedIndex)` |
| DoS | Unbounded loops | batches ≤100 adds / ≤50 claims; no loops over all payments in state-changing code |

## Trust assumptions

- The **approver** is trusted to check that the list is right. A hash proves the list wasn't changed, not that it is fair.
- The **funder** receives refunds. If an admin funds from a personal wallet, refunds go back there, even after that admin
  leaves the org. Anyone can trigger a refund, so it never depends on an admin being available.
- After publishing, a payment to a wrong wallet can't be redirected. It can only expire and be refunded. That's why the
  CSV validation and approval steps come before funding.
- The off-chain database is trusted for names, emails and descriptions only. Payment status shown to users comes from
  contract state (claim page) or from indexed events that are re-verified in reconciliation.

## Backend

- Wallet sign-in: single-use nonce (5 min) → personal_sign over a message with domain, chain id and issued-at →
  `verifyMessage` → DB session (token hashed with `SESSION_SECRET`), httpOnly, SameSite=Lax, Secure in production.
- Every org route checks DB membership and role bits, mirroring the contract's roles (synced from `MemberRolesSet`).
- Every on-chain step is reported as a tx hash. The server fetches the receipt and checks status, target contract,
  event names and arguments (run id, recipients, amounts in order) before changing anything.
- Zod validation on all input, body size limits, rate limits on auth and CSV endpoints, parameterized SQL only.
- Audit log row for every mutating action.
- Row-level security: the app talks to Postgres only from the server with one role. If you use Supabase, keep RLS enabled
  with no anon policies so the public API key can't read anything.

## Review notes (internal, by the lead engineer)

Findings fixed during the build:
- The claim deadline is inclusive (`> deadline` reverts); tested at the exact second.
- A failed `permit` (front-run) is ignored so it can't block funding.
- The approval threshold is snapshotted at submit, so lowering it later can't fast-track a pending run.
- Approvals reset on `returnToDraft` via an approval round counter.

Fixed after the independent audit (Nov 2026), see TESTING.md for proofs:
- Approvers are owner-controlled; admins can't mint or strip them.
- Approvals are re-counted against current roles at approve and at fund.
- The payment list is frozen after submit (no per-payment cancel once submitted).
- The API never overwrites a reviewed recipient with on-chain data; any difference blocks the run.
- Claim confirm does one receipt lookup and never holds connections; it is rate-limited per IP (platform header) and per payment id. It needs no session, because it only records what an on-chain `PaymentClaimed` log proves.
- Recipient wallets can't be the MUSD token, the escrow or the registry (CSV validator, API schemas and contract).
- Sign-in domain comes only from `NEXT_PUBLIC_APP_URL` in production.
- Security headers: CSP, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, and HSTS when served over https.

Known limitations:
- No separation of duties for the owner. An owner (who holds every role) can create, approve and fund alone. Orgs that
  want it set `approvalsRequired ≥ 2` and use separate approver wallets; admins can no longer get around that.
- Refunds go to the wallet that funded the run, even if that wallet later left the org.
- Payment ids are sequential, so anyone can look up org name, run name, wallet and amount for a payment (all already
  public on-chain). Descriptions are shown only to the recipient.
- CSP still allows 'unsafe-inline' scripts (Next's inline bootstrap without nonces).
- Recipients pay their own claim gas (small in BTC). Sponsored claims are on the roadmap.
