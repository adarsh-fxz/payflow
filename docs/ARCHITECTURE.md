# PayFlow — Architecture (FROZEN)

PayFlow lets an organization fund one MUSD escrow per payroll run and lets every recipient claim
their own payment. The chain holds the money and the payment records. Postgres holds the business
workflow (names, emails, departments, drafts, schedules, notifications) and an index of contract events.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Payment distribution | **On-chain payment records** added in batches of ≤100 (`addPayments`) | Owner's direction: prove escrow + claims + accounting first; Merkle later after measuring gas. Mezo testnet block gas limit is 10M. |
| Escrow topology | **One shared `PayrollEscrow`**, per-run ledgers | No per-run deployments; isolation via per-run `allocated/funded/claimed/refunded`. |
| Contracts | `OrganizationRegistry` (roles) + `PayrollEscrow` (runs, payments, claims, refunds) | The brief's PaymentRegistry/ClaimManager are folded into the escrow — fewer cross-contract trust edges; documented in CONTRACTS.md. |
| Payment ids | `paymentId = (runId << 32) \| index` | Deterministic; claim link `/claim/<paymentId>`. Changing the URL never helps: `claim` requires `msg.sender == recipient`. |
| Approval binding | Approver passes the run's `paymentsHash` (seeded with the claim window, then a rolling keccak over every add/cancel) | Approves exactly what is on-chain, including how long recipients have to claim; any change in between reverts. |
| Replay safety | `addPayments(expectedIndex, …)`; `createRun` rejects duplicate `runRef` per org | Re-sent txs revert instead of duplicating allocations or runs. |
| Funding | `approve` + `fund`, or `fundWithPermit` (MUSD supports EIP-2612) | Standard approval always works; permit saves a tx. |
| Post-publish | Payments are irrevocable until the claim window ends; then `expireRun` + `refund` | Employer can never pull money owed to recipients. |
| Token | MUSD `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` (testnet), 18 dec | Verified on-chain; `lib/chain/config.ts`. |
| Stack | Next.js 16 App Router, TypeScript strict, wagmi 2 + viem, Mezo Passport 0.17 (RainbowKit), TanStack Query, zod, react-hook-form, Tailwind 4, postgres.js (PGlite fallback), Foundry | Same as prior Mezo builds. |
| Wallets | **Mezo Passport**: Bitcoin wallets (Unisat, OKX, Xverse) through a Mezo smart account, or Ethereum wallets (MetaMask, Rabby, injected; WalletConnect when a project id is set) | Bitcoin holders use PayFlow without an EVM wallet. Config: `lib/client/wagmi.ts`. |
| Auth | Signed nonce (personal_sign) → httpOnly session cookie (DB-backed `sessions`). ECDSA recovery first; smart-account signatures are checked on chain (ERC-1271 / ERC-6492) | Business permissions bound to verified wallets; emails are contact info only. |
| Worker | `worker/run.ts` long-running (Render): indexer, schedule → draft runs, expiry reminders, email outbox | Vercel functions are not relied on for scheduled work. API also has on-demand per-tx sync so the app works without the worker. |
| Email | Resend HTTP API when `RESEND_API_KEY` is set; otherwise notifications are in-app only and `email_status = skipped` | No fake "sent". |

## Run lifecycle

```
off-chain draft ──createRun──▶ onchain_draft ──addPayments×N──▶ submitForApproval ──▶ pending_approval
   ▲                                    ▲                                                   │ approve (≥ threshold)
   └──────── edit (off-chain only) ─────┴──────────── returnToDraft ◀───────────────────────┤
                                                                                            ▼
                                     cancelled ◀── cancelRun ── approved ──fund──▶ funded ──publish──▶ published
                                                                                     │                    │ claims
                                                                       cancelPayment (admin)              ▼
                                                                                          partially_claimed / completed
                                                                                          deadline passed → expireRun → expired → refund
```
`partially_claimed` and `completed` are derived (0 < claimed < allocated, claimed == allocated).

## Roles

| Action | Contract check | Mask |
|---|---|---|
| createRun, addPayments, submitForApproval, cancelPayment (draft only), cancelRun (draft or pending) | `rolesOf & mask` | OPERATOR \| ADMIN |
| returnToDraft (pending) | | OPERATOR \| APPROVER \| ADMIN |
| returnToDraft (approved), cancelRun (approved) | | ADMIN |
| approve | | APPROVER (only approvers still holding the role count) |
| fund, publish, cancelRun (funded) | | ADMIN (fund re-checks valid approvals) |
| expireRun | anyone, after the deadline | — |
| refund | anyone; pays `run.funder` only | — |
| claim / claimMany | `msg.sender == payment.recipient` | — |
| grant/remove ADMIN or APPROVER, approval threshold, ownership | registry | owner only |
| grant/remove OPERATOR | registry | owner or ADMIN |
Owner holds all bits. Refunds always go to `run.funder`, never to the caller. The API re-checks the
same roles from DB members (kept in sync with `MemberRolesSet` events) before serving private data.

## Repository layout & ownership

| Path | Owner |
|---|---|
| `contracts/**`, `scripts/export-abi.mjs`, `lib/chain/**` | Lead (contracts) — FROZEN for others |
| `lib/api-types.ts`, `lib/server/db/schema.sql`, `docs/ARCHITECTURE.md` | Lead — FROZEN |
| `lib/server/**` (except schema.sql), `lib/csv/**`, `lib/money.ts`, `app/api/**`, `worker/**`, `tests/server/**`, `tests/csv/**` | Backend agent |
| `app/**` (except `app/api`), `components/**`, `hooks/**`, `lib/client/**`, `public/**`, `tests/ui/**`, `app/globals.css` | Frontend agent |
| `docs/*.md` other than ARCHITECTURE | Lead, at the end |

Shared pure modules the backend writes **first** (frontend imports them):
- `lib/money.ts`: `parseMusd(human: string): bigint` (throws on >18 decimals / invalid), `formatMusd(wei: bigint | string, opts?: { decimals?: number; compact?: boolean }): string`, `MUSD_UNIT = 10n ** 18n`.
- `lib/csv/validate.ts`: `validatePayrollCsv(text: string, opts?: { maxRows?: number; maxAmount?: string; employerBalanceWei?: string }): CsvValidationReport`, `validateRecipientCsv(...)` (same shape), `PAYROLL_CSV_TEMPLATE: string`, `toCsv(rows: Record<string, unknown>[], columns: string[]): string` (formula-injection safe: prefix `'` to cells starting with = + - @ tab CR).
  Isomorphic (no node-only imports), so the wizard validates instantly in the browser and the server re-validates on save.

## API routes (all JSON; see lib/api-types.ts)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/auth/nonce` · `POST /api/auth/verify` · `GET /api/auth/session` · `POST /api/auth/logout` | – | Wallet sign-in |
| `GET /api/health` | – | HealthResponse |
| `GET /api/orgs` · `POST /api/orgs` | session | My orgs / create (pending) |
| `GET/PATCH /api/orgs/:orgId` · `POST /api/orgs/:orgId/confirm` | member / admin / owner | Org detail, settings, confirm create tx |
| `GET/POST /api/orgs/:orgId/members` · `DELETE /api/orgs/:orgId/members/:memberId?txHash=` | member / admin | Members (tx-verified) |
| `GET/POST /api/orgs/:orgId/recipients` · `PATCH/DELETE /api/orgs/:orgId/recipients/:id` | member / operator | Directory (DELETE = set inactive) |
| `POST /api/orgs/:orgId/recipients/import` (`{csv}`) · `GET /api/orgs/:orgId/recipients/export` (text/csv) | operator / member | Bulk import / export |
| `POST /api/csv/validate` | session | ValidateCsvRequest → CsvValidationReport |
| `GET /api/csv/template?kind=payroll\|recipients` | – | Template download |
| `GET/POST /api/orgs/:orgId/runs` · `GET/PATCH/DELETE /api/orgs/:orgId/runs/:runId` | member / operator | Runs (PATCH/DELETE only off-chain draft) |
| `GET /api/orgs/:orgId/runs/:runId/plan` | operator | RunChainPlan for the next txs |
| `POST /api/orgs/:orgId/runs/:runId/tx` | role per action | RunTxRequest → verifies receipt, returns PayrollRunDetail |
| `POST /api/orgs/:orgId/runs/:runId/sync` | member | Re-read run + payments from chain (idempotent) |
| `GET /api/orgs/:orgId/runs/:runId/export` · `GET /api/orgs/:orgId/runs/:runId/manifest` | member | CSV report / manifest JSON |
| `GET /api/orgs/:orgId/dashboard` | member | DashboardStats |
| `GET /api/orgs/:orgId/reconciliation` · `GET /api/orgs/:orgId/reports/payments.csv?status=` | member | ReconciliationReport / CSV |
| `GET/POST /api/orgs/:orgId/schedules` · `PATCH/DELETE /api/orgs/:orgId/schedules/:id` · `POST …/:id/generate` | operator | Recurring templates; manual "generate draft now" |
| `GET /api/claims/:paymentId` | optional session | ClaimInfo (description only for the recipient's session) |
| `POST /api/claims/:paymentId/confirm` | – | `{txHash}` → verifies PaymentClaimed log, records it |
| `GET /api/me/payments` | session | RecipientDashboard (payments to the session wallet across orgs) |
| `GET /api/notifications` · `POST /api/notifications/read` | session | In-app notifications |
| `POST /api/indexer/sync` | `Authorization: Bearer $INDEXER_SECRET` | One indexer pass (cron fallback); 503 if the pass failed |
| `POST /api/orgs/:orgId/recover` | owner | Find the org's `OrganizationCreated` log and activate it (GET org sends `x-payflow-recover: available` when useful) |
| `POST /api/orgs/:orgId/metadata/confirm` | admin | `{txHash}` of `setMetadata` after a profile edit (PATCH returns `metadataChanged`) |
| `GET /api/orgs/:orgId/reports/summary` · `GET …/reports/recipients.csv` | member | ReportsSummary / per-recipient CSV |

### Integrity rules (added after the Nov 2026 audit)
- The reviewed claim window is never overwritten; the chain value is stored in `chain_claim_window_seconds`, and a difference blocks the run like a payment mismatch.
- Reviewed draft items are immutable once a run goes on-chain. On-chain values are stored separately (`chain_*` columns). Any difference sets `chainMismatch` on the run, and approve/fund/publish reports return **409 `chain_mismatch`**. The expected `paymentsHash` is computed only from reviewed items, in on-chain event order.
- Lifecycle notifications are emitted when events are indexed (deduped), never inferred from status changes. Reminders only follow a `payment_available`.
- Chain failures return **503 `chain_unavailable`**; `/api/health` reports `rpc` and sets `ok:false` when it's down.
- `POST /api/claims/:id/confirm` needs no session (recipients claim without signing in): it does one receipt lookup, never waits (409 until mined), only records what a `PaymentClaimed` log proves, and is rate-limited per IP (the platform's client-IP header) and per payment id. The worker indexes claims anyway, so a failed confirm never loses data.
- In production, sign-in requires `NEXT_PUBLIC_APP_URL`; the domain is never taken from request headers.

## Environment

| Var | Used by |
|---|---|
| `NEXT_PUBLIC_MEZO_RPC_URL`, `NEXT_PUBLIC_MUSD_ADDRESS`, `NEXT_PUBLIC_ESCROW_ADDRESS`, `NEXT_PUBLIC_REGISTRY_ADDRESS`, `NEXT_PUBLIC_DEPLOY_BLOCK` | web, worker |
| `NEXT_PUBLIC_APP_URL` | links in emails / claim links, sign-in domain, Passport app URL |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (optional) | adds WalletConnect to the Passport modal |
| `DATABASE_URL` (unset → PGlite at `.data/pglite`) | API, worker |
| `SESSION_SECRET` (≥32 chars) | API |
| `INDEXER_SECRET` | `/api/indexer/sync` |
| `RESEND_API_KEY`, `EMAIL_FROM` | worker (optional) |
| `DEPLOYER_PRIVATE_KEY` | contracts/.env only |
