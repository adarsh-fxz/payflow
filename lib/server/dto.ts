/** DB row types and row → DTO mappers (lib/api-types.ts shapes). */
import "./guard";
import type {
  Approval, ChainMismatch, Hex, Member, Organization, PayrollItem, PayrollRun, PayrollRunDetail, Recipient, RunStatus, Schedule,
  ItemClaimStatus, PaymentCategory, PaymentFrequency, Notification, NotificationKind,
} from "../api-types";
import type { OrgRow } from "./authz";

export const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
const hex = (v: string | null | undefined): Hex | null => (v ? (v.toLowerCase() as Hex) : null);
const wei = (v: string | number | bigint | null | undefined): string => (v == null ? "0" : BigInt(String(v).split(".")[0]!).toString());

export function orgDto(o: OrgRow, myRoles: number): Organization {
  return {
    id: o.id,
    chainOrgId: o.chain_org_id == null ? null : String(o.chain_org_id),
    name: o.name,
    slug: o.slug,
    description: o.description,
    logoUrl: o.logo_url,
    ownerWallet: o.owner_wallet as Hex,
    treasuryWallet: hex(o.treasury_wallet),
    metadataHash: o.metadata_hash as Hex,
    defaultClaimWindowDays: Number(o.default_claim_window_days),
    createTxHash: hex(o.create_tx_hash),
    status: o.status === "active" ? "active" : "pending",
    createdAt: iso(o.created_at)!,
    myRoles,
  };
}

export interface MemberRow {
  id: string;
  organization_id: string;
  wallet_address: string;
  email: string | null;
  display_name: string | null;
  roles: number;
  status: string;
  tx_hash: string | null;
  invited_at: Date;
}
export function memberDto(m: MemberRow): Member {
  return {
    id: m.id,
    walletAddress: m.wallet_address as Hex,
    email: m.email,
    displayName: m.display_name,
    roles: Number(m.roles),
    status: (["pending", "active", "removed"].includes(m.status) ? m.status : "pending") as Member["status"],
    txHash: hex(m.tx_hash),
    invitedAt: iso(m.invited_at)!,
  };
}

export interface RecipientRow {
  id: string;
  organization_id: string;
  name: string;
  email: string | null;
  wallet_address: string;
  external_id: string | null;
  department: string | null;
  payment_category: string | null;
  payment_frequency: string | null;
  default_amount: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_paid_at?: Date | null;
}
export function recipientDto(r: RecipientRow): Recipient {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    walletAddress: r.wallet_address as Hex,
    externalId: r.external_id,
    department: r.department,
    paymentCategory: (r.payment_category as PaymentCategory | null) ?? null,
    paymentFrequency: (r.payment_frequency as PaymentFrequency | null) ?? null,
    defaultAmount: r.default_amount == null ? null : wei(r.default_amount),
    status: r.status === "inactive" ? "inactive" : "active",
    lastPaidAt: iso(r.last_paid_at ?? null),
    createdAt: iso(r.created_at)!,
  };
}

export interface RunRow {
  id: string;
  organization_id: string;
  chain_run_id: string | null;
  run_ref: string;
  name: string;
  payment_category: string;
  frequency: string;
  schedule_id: string | null;
  total_amount: string;
  recipient_count: number;
  token_address: string;
  scheduled_at: Date | null;
  claim_window_days: number;
  chain_claim_window_seconds?: number | null;
  status: string;
  payments_hash: string | null;
  funded_amount: string;
  claimed_amount: string;
  refunded_amount: string;
  claimed_count: number;
  claim_deadline: Date | null;
  funder_wallet: string | null;
  create_tx_hash: string | null;
  fund_tx_hash: string | null;
  publish_tx_hash: string | null;
  created_by: string;
  approved_by: string | null;
  approvals_required: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface ItemRow {
  id: string;
  payroll_run_id: string;
  recipient_id: string | null;
  item_index: number;
  name: string;
  email: string | null;
  department: string | null;
  recipient_address: string;
  amount: string;
  description: string;
  payment_id: string | null;
  claim_status: string;
  allocate_tx_hash: string | null;
  transaction_hash: string | null;
  claimed_at: Date | null;
  chain_recipient_address: string | null;
  chain_amount: string | null;
  /** false for an on-chain payment that has no reviewed draft item. */
  reviewed: boolean;
}

export interface ApprovalRow {
  approver_wallet: string;
  status: string;
  approved_at: Date;
  rejection_reason: string | null;
  tx_hash: string | null;
}

/** Statuses in which the escrow holds a liability towards recipients. */
export const LIABLE_STATUSES: readonly RunStatus[] = ["funded", "published", "partially_claimed", "completed"];
export const ONCHAIN_STATUSES: readonly RunStatus[] = ["onchain_draft", "pending_approval", "approved", "funded", "published", "partially_claimed", "completed", "cancelled", "expired"];

export function runLiability(r: Pick<RunRow, "status" | "total_amount" | "claimed_amount">): bigint {
  if (!LIABLE_STATUSES.includes(r.status as RunStatus)) return 0n;
  const v = BigInt(wei(r.total_amount)) - BigInt(wei(r.claimed_amount));
  return v > 0n ? v : 0n;
}

export function runRefundable(r: Pick<RunRow, "status" | "total_amount" | "claimed_amount" | "funded_amount" | "refunded_amount">): bigint {
  const v = BigInt(wei(r.funded_amount)) - BigInt(wei(r.claimed_amount)) - BigInt(wei(r.refunded_amount)) - runLiability(r);
  return v > 0n ? v : 0n;
}

export function approvalDto(a: ApprovalRow): Approval {
  return {
    approverWallet: a.approver_wallet as Hex,
    status: a.status === "rejected" ? "rejected" : "approved",
    approvedAt: iso(a.approved_at)!,
    rejectionReason: a.rejection_reason,
    txHash: hex(a.tx_hash),
  };
}

/** Values that do not live on the run row: live chain reads and the reviewed-vs-chain comparison. */
export interface RunExtras {
  validApprovals: number | null;
  approvalsRequired: number | null;
  chainMismatch: ChainMismatch[];
}
export const NO_EXTRAS: RunExtras = { validApprovals: null, approvalsRequired: null, chainMismatch: [] };

export function runDto(r: RunRow, approvals: ApprovalRow[], extras: RunExtras = NO_EXTRAS): PayrollRun {
  return {
    id: r.id,
    organizationId: r.organization_id,
    chainRunId: r.chain_run_id == null ? null : String(r.chain_run_id),
    runRef: r.run_ref as Hex,
    name: r.name,
    paymentCategory: r.payment_category as PaymentCategory,
    frequency: r.frequency === "monthly" ? "monthly" : "one_time",
    scheduleId: r.schedule_id,
    totalAmount: wei(r.total_amount),
    recipientCount: Number(r.recipient_count),
    tokenAddress: r.token_address as Hex,
    scheduledAt: iso(r.scheduled_at),
    claimWindowDays: Number(r.claim_window_days),
    status: r.status as RunStatus,
    paymentsHash: hex(r.payments_hash),
    fundedAmount: wei(r.funded_amount),
    claimedAmount: wei(r.claimed_amount),
    refundedAmount: wei(r.refunded_amount),
    outstandingAmount: runLiability(r).toString(),
    claimedCount: Number(r.claimed_count),
    claimDeadline: iso(r.claim_deadline),
    funderWallet: hex(r.funder_wallet),
    createTxHash: hex(r.create_tx_hash),
    fundTxHash: hex(r.fund_tx_hash),
    publishTxHash: hex(r.publish_tx_hash),
    createdBy: r.created_by as Hex,
    approvedBy: hex(r.approved_by),
    approvals: approvals.map(approvalDto),
    validApprovals: extras.validApprovals,
    approvalsRequired: extras.approvalsRequired,
    chainMismatch: extras.chainMismatch,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export function itemDto(i: ItemRow): PayrollItem {
  return {
    id: i.id,
    index: Number(i.item_index),
    recipientId: i.recipient_id,
    name: i.name,
    email: i.email,
    department: i.department,
    recipientAddress: i.recipient_address as Hex,
    amount: wei(i.amount),
    description: i.description,
    paymentId: i.payment_id == null ? null : String(i.payment_id),
    claimStatus: i.claim_status as ItemClaimStatus,
    transactionHash: hex(i.transaction_hash),
    claimedAt: iso(i.claimed_at),
  };
}

export function runDetailDto(r: RunRow, approvals: ApprovalRow[], items: ItemRow[], extras: RunExtras = NO_EXTRAS): PayrollRunDetail {
  return { ...runDto(r, approvals, extras), items: items.map(itemDto) };
}

export interface ScheduleRow {
  id: string;
  organization_id: string;
  name: string;
  payment_category: string;
  frequency: string;
  day_of_month: number | null;
  weekday: number | null;
  items_json: { recipient_id: string; amount: string; description: string }[];
  next_run_at: Date;
  last_generated_at: Date | null;
  active: boolean;
  created_by: string;
  created_at: Date;
}
export function scheduleDto(s: ScheduleRow): Schedule {
  const items = (Array.isArray(s.items_json) ? s.items_json : []).map((i) => ({ recipientId: i.recipient_id, amount: wei(i.amount), description: i.description ?? "" }));
  return {
    id: s.id,
    name: s.name,
    paymentCategory: s.payment_category as PaymentCategory,
    frequency: s.frequency as Schedule["frequency"],
    dayOfMonth: s.day_of_month == null ? null : Number(s.day_of_month),
    weekday: s.weekday == null ? null : Number(s.weekday),
    items,
    nextRunAt: iso(s.next_run_at)!,
    lastGeneratedAt: iso(s.last_generated_at),
    active: Boolean(s.active),
    totalWei: items.reduce((a, i) => a + BigInt(i.amount), 0n).toString(),
  };
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}
export function notificationDto(n: NotificationRow): Notification {
  return { id: n.id, kind: n.kind as NotificationKind, title: n.title, body: n.body, link: n.link, readAt: iso(n.read_at), createdAt: iso(n.created_at)! };
}
