// FROZEN. Shared request/response shapes for every /api route (see docs/API.md).
// Money: MUSD wei as decimal strings ("1500000000000000000000" = 1,500 MUSD). Addresses lowercase 0x.
// Every error response: { error: { code: ApiErrorCode, message: string, details?: unknown } }.

export type Wei = string;
export type Hex = `0x${string}`;

export type ApiErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "rate_limited"
  | "chain_mismatch"
  | "not_deployed"
  | "chain_unavailable"   // RPC unreachable or timed out (HTTP 503)
  | "internal";

export interface ApiError {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}

// ---------- auth ----------
export interface NonceRequest { address: Hex }
export interface NonceResponse { nonce: string; message: string; expiresAt: string }
/** message is the exact text from NonceResponse; signature from personal_sign. */
export interface VerifyRequest { address: Hex; message: string; signature: Hex }
export interface SessionResponse { address: Hex | null }

// ---------- organizations ----------
export type OrgRole = "owner" | "admin" | "approver" | "operator";
/** Roles bitmask: 1 admin, 2 approver, 4 operator; owner = 7. */
export type RolesMask = number;

export interface Organization {
  id: string;
  chainOrgId: string | null;
  name: string;
  slug: string;
  description: string;
  logoUrl: string | null;
  ownerWallet: Hex;
  treasuryWallet: Hex | null;
  metadataHash: Hex;
  defaultClaimWindowDays: number;
  createTxHash: Hex | null;
  status: "pending" | "active";
  createdAt: string;
  /** Caller's roles in this org (0 if none). */
  myRoles: RolesMask;
}

/** Step 1: POST /api/orgs → returns org (status pending) + metadataHash to pass to createOrganization().
 *  Step 2: POST /api/orgs/:id/confirm { txHash } → server reads receipt, sets chainOrgId, status active. */
export interface CreateOrgRequest {
  name: string;
  description?: string;
  logoUrl?: string | null;
  treasuryWallet?: Hex | null;
  defaultClaimWindowDays?: number;
  /** Owner's email for employer notifications (optional; contact only, never an identity). */
  email?: string | null;
}
export interface ConfirmTxRequest { txHash: Hex }
export interface UpdateOrgRequest {
  name?: string;
  description?: string;
  logoUrl?: string | null;
  treasuryWallet?: Hex | null;
  defaultClaimWindowDays?: number;
}

export interface Member {
  id: string;
  walletAddress: Hex;
  email: string | null;
  displayName: string | null;
  roles: RolesMask;
  status: "pending" | "active" | "removed";
  txHash: Hex | null;
  invitedAt: string;
}
/** Client sends setMemberRoles on-chain first, then POSTs here with txHash; server verifies the event. */
export interface UpsertMemberRequest {
  walletAddress: Hex;
  roles: RolesMask;
  email?: string | null;
  displayName?: string | null;
  txHash: Hex;
}

// ---------- recipients ----------
export type PaymentCategory = "salary" | "contractor" | "bounty" | "reward" | "grant" | "custom";
export type PaymentFrequency = "one_time" | "weekly" | "biweekly" | "monthly";

export interface Recipient {
  id: string;
  name: string;
  email: string | null;
  walletAddress: Hex;
  externalId: string | null;
  department: string | null;
  paymentCategory: PaymentCategory | null;
  paymentFrequency: PaymentFrequency | null;
  defaultAmount: Wei | null;
  status: "active" | "inactive";
  lastPaidAt: string | null;
  createdAt: string;
}
export interface RecipientInput {
  name: string;
  email?: string | null;
  walletAddress: string;
  externalId?: string | null;
  department?: string | null;
  paymentCategory?: PaymentCategory | null;
  paymentFrequency?: PaymentFrequency | null;
  /** Human MUSD amount, e.g. "1500.50". */
  defaultAmount?: string | null;
  status?: "active" | "inactive";
}
export interface RecipientListQuery { q?: string; department?: string; status?: string; page?: number; pageSize?: number }
export interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }

// ---------- CSV ----------
/** Payroll CSV columns: name,email,wallet_address,amount,description,department (header row required;
 *  name, wallet_address, amount required). Recipient CSV adds: external_id,payment_category,payment_frequency. */
export type CsvIssueCode =
  | "missing_column"
  | "unknown_column"
  | "empty_value"
  | "invalid_wallet"
  | "invalid_amount"
  | "non_positive_amount"
  | "too_many_decimals"
  | "amount_too_large"
  | "invalid_email"
  | "duplicate_wallet"
  | "duplicate_row"
  | "unsupported_characters"
  | "too_many_rows"
  | "file_too_large"
  | "not_csv";

export interface CsvIssue { row: number | null; column: string | null; code: CsvIssueCode; message: string; severity: "error" | "warning" }

export interface CsvRow {
  /** 1-based data row number (header = 0). */
  row: number;
  name: string;
  email: string | null;
  walletAddress: string;          // checksum-normalized when valid, raw otherwise
  amount: string;                 // human, as typed
  amountWei: Wei | null;          // null when invalid
  description: string;
  department: string | null;
  valid: boolean;
  issues: CsvIssue[];
}

export interface CsvValidationReport {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateWallets: number;
  invalidWallets: number;
  payableRecipients: number;
  totalPayableWei: Wei;
  fileIssues: CsvIssue[];          // whole-file problems (missing columns, size, etc.)
  rows: CsvRow[];                  // every row, valid or not — never silently dropped
  /** Present when the employer's wallet balance was supplied. */
  balanceCheck?: { balanceWei: Wei; sufficient: boolean };
}

export interface ValidateCsvRequest { csv: string; employerBalanceWei?: Wei; maxAmountPerRow?: string }

// ---------- payroll runs ----------
export type RunStatus =
  | "draft"              // off-chain only
  | "onchain_draft"      // createRun sent, allocations being added
  | "pending_approval"
  | "approved"
  | "funded"
  | "published"
  | "partially_claimed"
  | "completed"
  | "cancelled"
  | "expired";

export type ItemClaimStatus = "pending" | "allocated" | "claimed" | "cancelled" | "expired";

export interface PayrollItem {
  id: string;
  index: number;
  recipientId: string | null;
  name: string;
  email: string | null;
  department: string | null;
  recipientAddress: Hex;
  amount: Wei;
  description: string;
  paymentId: string | null;
  claimStatus: ItemClaimStatus;
  transactionHash: Hex | null;
  claimedAt: string | null;
}

export interface PayrollRun {
  id: string;
  organizationId: string;
  chainRunId: string | null;
  runRef: Hex;
  name: string;
  paymentCategory: PaymentCategory;
  frequency: "one_time" | "monthly";
  scheduleId: string | null;
  totalAmount: Wei;
  recipientCount: number;
  tokenAddress: Hex;
  scheduledAt: string | null;
  claimWindowDays: number;
  status: RunStatus;
  paymentsHash: Hex | null;
  fundedAmount: Wei;
  claimedAmount: Wei;
  refundedAmount: Wei;
  outstandingAmount: Wei;
  claimedCount: number;
  claimDeadline: string | null;
  funderWallet: Hex | null;
  createTxHash: Hex | null;
  fundTxHash: Hex | null;
  publishTxHash: Hex | null;
  createdBy: Hex;
  approvedBy: Hex | null;
  approvals: Approval[];
  /** Live from PayrollEscrow.validApprovals / run.approvalsRequired; null before submit or when the chain is unreachable. */
  validApprovals: number | null;
  approvalsRequired: number | null;
  /** Non-empty when the on-chain allocation differs from the reviewed draft item. The run is BLOCKED:
   *  approve/fund/publish are refused by the API and the UI must show the differences and offer cancel. */
  chainMismatch: ChainMismatch[];
  createdAt: string;
  updatedAt: string;
}
export interface ChainMismatch {
  /** "claim_window": the run's on-chain claim window differs from the reviewed one (index is -1). */
  kind?: "payment" | "claim_window";
  reviewedClaimWindowSeconds?: number;
  chainClaimWindowSeconds?: number;
  index: number;
  name: string;
  reviewedRecipient: Hex;
  reviewedAmount: Wei;
  chainRecipient: Hex;
  chainAmount: Wei;
  txHash: Hex | null;
}
export interface PayrollRunDetail extends PayrollRun { items: PayrollItem[] }

export interface Approval { approverWallet: Hex; status: "approved" | "rejected"; approvedAt: string; rejectionReason: string | null; txHash: Hex | null }

export interface RunItemInput {
  recipientId?: string | null;
  name: string;
  email?: string | null;
  department?: string | null;
  walletAddress: string;
  /** Human MUSD amount. */
  amount: string;
  description?: string;
}
export interface CreateRunRequest {
  name: string;
  paymentCategory: PaymentCategory;
  frequency: "one_time" | "monthly";
  scheduledAt?: string | null;
  claimWindowDays?: number;
  items: RunItemInput[];
}
/** Only while status = draft. Replaces all items. */
export type UpdateRunRequest = Partial<CreateRunRequest>;

/**
 * On-chain progression. The client sends the tx, then reports the hash; the server verifies the
 * receipt + emitted events against the DB before changing status (idempotent; safe to repeat).
 *   action "create"   → createRun tx           (draft → onchain_draft, sets chainRunId)
 *   action "allocate" → addPayments batch tx   (records payment ids for that batch)
 *   action "submit"   → submitForApproval tx   (onchain_draft → pending_approval)
 *   action "approve"  → approve tx             (→ approved when threshold met)
 *   action "return"   → returnToDraft tx       (→ onchain_draft)
 *   action "fund"     → fund / fundWithPermit  (approved → funded)
 *   action "publish"  → publish tx             (funded → published, notifies recipients)
 *   action "cancel"   → cancelRun tx
 *   action "cancel_payment" → cancelPayment tx
 *   action "expire"   → expireRun tx
 *   action "refund"   → refund tx
 */
export type RunTxAction = "create" | "allocate" | "submit" | "approve" | "return" | "fund" | "publish" | "cancel" | "cancel_payment" | "expire" | "refund";
export interface RunTxRequest { action: RunTxAction; txHash: Hex; rejectionReason?: string }

/** Everything the client needs to build the next on-chain tx for a run. */
export interface RunChainPlan {
  runRef: Hex;
  chainRunId: string | null;
  claimWindowSeconds: number;
  /** Remaining addPayments batches (≤ MAX_BATCH each), in order. */
  batches: { expectedIndex: number; recipients: Hex[]; amounts: Wei[] }[];
  expectedPaymentsHash: Hex | null;
  allocatedWei: Wei;
}

// ---------- claims (recipient side) ----------
export interface ClaimInfo {
  paymentId: string;
  chainRunId: string;
  index: number;
  organization: { name: string; slug: string; logoUrl: string | null };
  runName: string;
  /** Only when the session wallet is the designated recipient; otherwise null. */
  description: string | null;
  recipientAddress: Hex;
  amount: Wei;
  /** Read live from the contract, not the DB. */
  status: "allocated" | "claimed" | "cancelled" | "not_published" | "expired";
  claimDeadline: string | null;
  claimedAt: string | null;
  transactionHash: Hex | null;
}

export interface RecipientPayment {
  paymentId: string;
  organization: { name: string; slug: string; logoUrl: string | null };
  runName: string;
  description: string;
  amount: Wei;
  status: "available" | "claimed" | "cancelled" | "expired" | "upcoming";
  claimDeadline: string | null;
  claimedAt: string | null;
  transactionHash: Hex | null;
}
export interface RecipientDashboard { address: Hex; totalReceivedWei: Wei; availableWei: Wei; payments: RecipientPayment[] }

// ---------- dashboard & reports ----------
export interface DashboardStats {
  totalPaidWei: Wei;          // claimed
  totalAllocatedWei: Wei;     // funded into published/funded runs
  totalClaimedWei: Wei;
  outstandingWei: Wei;        // liability still claimable
  refundableWei: Wei;
  recipientCount: number;
  runCount: number;
  upcoming: { runId: string | null; scheduleId: string | null; name: string; date: string; amountWei: Wei }[];
  recentActivity: ActivityItem[];
  monthlyVolume: { month: string; fundedWei: Wei; claimedWei: Wei }[];
  claimCompletion: { claimed: number; unclaimed: number; cancelled: number; expired: number };
}
export interface ActivityItem { id: string; kind: string; title: string; detail: string; amountWei: Wei | null; txHash: Hex | null; at: string }

/** Reconciliation compares indexed DB totals with live PayrollEscrow.getRun() per run. */
export interface ReconciliationRow {
  runId: string;
  chainRunId: string | null;
  name: string;
  status: RunStatus;
  db: { fundedWei: Wei; allocatedWei: Wei; claimedWei: Wei; refundedWei: Wei; outstandingWei: Wei };
  chain: { fundedWei: Wei; allocatedWei: Wei; claimedWei: Wei; refundedWei: Wei; outstandingWei: Wei; refundableWei: Wei } | null;
  matches: boolean;
}
export interface ReconciliationReport {
  generatedAt: string;
  rows: ReconciliationRow[];
  totals: { fundedWei: Wei; allocatedWei: Wei; claimedWei: Wei; outstandingWei: Wei; refundableWei: Wei };
  allMatch: boolean;
  escrow: { address: Hex; totalHeldWei: Wei; balanceWei: Wei };
}

// ---------- schedules ----------
export interface Schedule {
  id: string;
  name: string;
  paymentCategory: PaymentCategory;
  frequency: "weekly" | "biweekly" | "monthly";
  dayOfMonth: number | null;
  weekday: number | null;
  items: { recipientId: string; amount: Wei; description: string }[];
  nextRunAt: string;
  lastGeneratedAt: string | null;
  active: boolean;
  totalWei: Wei;
}
export interface ScheduleInput {
  name: string;
  paymentCategory: PaymentCategory;
  frequency: "weekly" | "biweekly" | "monthly";
  dayOfMonth?: number | null;
  weekday?: number | null;
  items: { recipientId: string; amount: string; description?: string }[];
  active?: boolean;
}

// ---------- notifications ----------
export type NotificationKind =
  | "run_created" | "run_awaiting_approval" | "run_approved" | "run_funded" | "run_published"
  | "payment_claimed" | "run_completed" | "claims_expiring" | "schedule_draft_created"
  | "payment_available" | "payment_reminder" | "payment_received" | "payment_cancelled" | "payment_expired";
export interface Notification { id: string; kind: NotificationKind; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }

/** POST /api/orgs/:orgId/recover — finds the org's OrganizationCreated event on-chain (owner + metadataHash)
 *  and activates it, so a lost confirm call never forces a second on-chain org. */
export interface RecoverOrgResponse { recovered: boolean; organization: Organization; txHash: Hex | null }

/** GET /api/orgs/:orgId/reports/summary */
export interface ReportsSummary {
  generatedAt: string;
  payroll: { runs: number; completedRuns: number; publishedRuns: number; fundedWei: Wei; claimedWei: Wei; outstandingWei: Wei; refundedWei: Wei };
  completedRuns: { runId: string; name: string; completedAt: string | null; totalWei: Wei; recipientCount: number }[];
  unclaimed: { runId: string; runName: string; paymentId: string; name: string; recipientAddress: Hex; amountWei: Wei; claimDeadline: string | null }[];
  outstandingByRun: { runId: string; name: string; outstandingWei: Wei; claimDeadline: string | null }[];
  monthlyVolume: { month: string; fundedWei: Wei; claimedWei: Wei }[];
  recipients: { recipientAddress: Hex; name: string; paymentCount: number; paidWei: Wei; unclaimedWei: Wei; lastPaidAt: string | null }[];
}
// GET /api/orgs/:orgId/reports/recipients.csv — the recipients block above as CSV.

export interface HealthResponse { ok: boolean; rpc: "ok" | "down"; db: "postgres" | "pglite"; chainId: number; deployed: boolean; escrow: Hex; registry: Hex; musd: Hex; latestBlock: string | null; indexedBlock: string | null }
