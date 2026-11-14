/** Recipient side: claim info (read live from the contract), claim confirmation, my payments. */
import "./guard";
import type { ClaimInfo, Hex, RecipientDashboard, RecipientPayment } from "../api-types";
import { CHAIN_PAYMENT_STATUS, CHAIN_RUN_STATUS, contracts, splitPaymentId } from "../chain/config";
import type { Db } from "./db";
import { fail } from "./http";
import { iso } from "./dto";
import { fetchReceipt, readPayment, readRun, requireDeployed, type ChainLog, type ChainPayment, type ChainRun, type VerifiedReceipt } from "./chain";
import { applyLogs } from "./indexer";

export function parsePaymentId(raw: string): bigint {
  if (!/^\d{1,78}$/.test(raw)) throw fail("not_found", "Payment not found");
  const v = BigInt(raw);
  if (v >> 32n === 0n) throw fail("not_found", "Payment not found");
  return v;
}

/** Pure status mapping from live contract state. */
export function claimStatusFromChain(payment: Pick<ChainPayment, "status">, run: Pick<ChainRun, "status" | "claimDeadline">, nowSec: bigint): ClaimInfo["status"] {
  const ps = CHAIN_PAYMENT_STATUS[payment.status];
  const rs = CHAIN_RUN_STATUS[run.status];
  if (ps === "claimed") return "claimed";
  if (ps === "cancelled" || rs === "cancelled") return "cancelled";
  if (rs === "expired") return "expired";
  if (rs !== "published") return "not_published";
  return nowSec > run.claimDeadline ? "expired" : "allocated";
}

interface ClaimDbRow {
  run_name: string;
  description: string;
  org_name: string;
  org_slug: string;
  logo_url: string | null;
  transaction_hash: string | null;
}

export async function getClaimInfo(db: Db, rawId: string, sessionWallet: string | null): Promise<ClaimInfo> {
  requireDeployed();
  const pid = parsePaymentId(rawId);
  const { runId, index } = splitPaymentId(pid);
  const payment = await readPayment(pid);
  if (!payment) throw fail("not_found", "Payment not found");
  const run = await readRun(runId);

  const rows = await db.query<ClaimDbRow>(
    `SELECT r.name AS run_name, i.description, o.name AS org_name, o.slug AS org_slug, o.logo_url,
            COALESCE(c.transaction_hash, i.transaction_hash) AS transaction_hash
     FROM payroll_items i
     JOIN payroll_runs r ON r.id = i.payroll_run_id
     JOIN organizations o ON o.id = r.organization_id
     LEFT JOIN payment_claims c ON c.payment_id = i.payment_id
     WHERE i.payment_id = $1`,
    [pid.toString()],
  );
  let row = rows[0];
  if (!row) {
    // Run not created through PayFlow's DB (or not indexed yet): fall back to the on-chain org.
    const org = await db.query<{ name: string; slug: string; logo_url: string | null }>(`SELECT name, slug, logo_url FROM organizations WHERE chain_org_id = $1`, [run.orgId.toString()]);
    row = {
      run_name: `Payroll run #${runId}`,
      description: "",
      org_name: org[0]?.name ?? `Organization #${run.orgId}`,
      org_slug: org[0]?.slug ?? "",
      logo_url: org[0]?.logo_url ?? null,
      transaction_hash: null,
    };
  }
  const isRecipient = sessionWallet != null && sessionWallet.toLowerCase() === payment.recipient;
  return {
    paymentId: pid.toString(),
    chainRunId: runId.toString(),
    index,
    organization: { name: row.org_name, slug: row.org_slug, logoUrl: row.logo_url },
    runName: row.run_name,
    description: isRecipient ? row.description : null,
    recipientAddress: payment.recipient as Hex,
    amount: payment.amount.toString(),
    status: claimStatusFromChain(payment, run, BigInt(Math.floor(Date.now() / 1000))),
    claimDeadline: run.claimDeadline > 0n ? new Date(Number(run.claimDeadline) * 1000).toISOString() : null,
    claimedAt: payment.claimedAt > 0n ? new Date(Number(payment.claimedAt) * 1000).toISOString() : null,
    transactionHash: (row.transaction_hash as Hex | null) ?? null,
  };
}

/**
 * Pure check of a claim receipt. Accepts a direct call to the escrow, or a call through a smart
 * wallet / relayer (tx.to ≠ escrow) as long as the receipt carries a PaymentClaimed log emitted BY
 * the escrow for exactly this payment. decodeLogs only decodes logs whose address is the escrow or
 * registry, so a look-alike event from another contract can never match.
 */
export function verifyClaimReceipt(receipt: VerifiedReceipt, pid: bigint): ChainLog {
  if (receipt.status !== "success") throw fail("chain_mismatch", "Transaction reverted on-chain");
  const escrow = contracts.escrow.toLowerCase();
  const ev = receipt.logs.find((l) => l.address === escrow && l.eventName === "PaymentClaimed" && String(l.args.paymentId) === pid.toString());
  if (!ev) throw fail("chain_mismatch", "Transaction did not claim this payment");
  return ev;
}

/** Verifies a PaymentClaimed log for this payment in the tx and records it (idempotent). No receipt polling. */
export async function confirmClaim(db: Db, rawId: string, txHash: Hex, sessionWallet: string | null): Promise<ClaimInfo> {
  requireDeployed();
  const pid = parsePaymentId(rawId);
  const receipt = await fetchReceipt(txHash);
  verifyClaimReceipt(receipt, pid);
  await applyLogs(db, receipt.logs);
  return getClaimInfo(db, rawId, sessionWallet);
}

interface MyPaymentRow {
  payment_id: string;
  run_status: string;
  claim_status: string;
  amount: string;
  description: string;
  run_name: string;
  claim_deadline: Date | null;
  claimed_at: Date | null;
  transaction_hash: string | null;
  org_name: string;
  org_slug: string;
  logo_url: string | null;
}

export function recipientPaymentStatus(r: Pick<MyPaymentRow, "run_status" | "claim_status" | "claim_deadline">, now: Date): RecipientPayment["status"] {
  if (r.claim_status === "claimed") return "claimed";
  if (r.claim_status === "cancelled" || r.run_status === "cancelled") return "cancelled";
  if (r.claim_status === "expired" || r.run_status === "expired") return "expired";
  if (r.run_status === "funded" || r.run_status === "approved") return "upcoming";
  if (r.claim_deadline && now.getTime() > new Date(r.claim_deadline).getTime()) return "expired";
  return "available";
}

export async function myPayments(db: Db, wallet: string, now = new Date()): Promise<RecipientDashboard> {
  const rows = await db.query<MyPaymentRow>(
    `SELECT i.payment_id::text AS payment_id, r.status AS run_status, i.claim_status, i.amount::text AS amount, i.description, r.name AS run_name,
            r.claim_deadline, i.claimed_at, i.transaction_hash, o.name AS org_name, o.slug AS org_slug, o.logo_url
     FROM payroll_items i
     JOIN payroll_runs r ON r.id = i.payroll_run_id
     JOIN organizations o ON o.id = r.organization_id
     WHERE i.recipient_address = $1 AND i.payment_id IS NOT NULL
       AND (r.status IN ('approved', 'funded', 'published', 'partially_claimed', 'completed', 'expired')
            OR (r.status = 'cancelled' AND r.funded_amount > 0))
     ORDER BY COALESCE(i.claimed_at, r.claim_deadline, r.created_at) DESC
     LIMIT 1000`,
    [wallet.toLowerCase()],
  );
  let received = 0n;
  let available = 0n;
  const payments: RecipientPayment[] = rows.map((r) => {
    const status = recipientPaymentStatus(r, now);
    const amt = BigInt(r.amount);
    if (status === "claimed") received += amt;
    if (status === "available") available += amt;
    return {
      paymentId: r.payment_id,
      organization: { name: r.org_name, slug: r.org_slug, logoUrl: r.logo_url },
      runName: r.run_name,
      description: r.description,
      amount: amt.toString(),
      status,
      claimDeadline: iso(r.claim_deadline),
      claimedAt: iso(r.claimed_at),
      transactionHash: (r.transaction_hash as Hex | null) ?? null,
    };
  });
  return { address: wallet.toLowerCase() as Hex, totalReceivedWei: received.toString(), availableWei: available.toString(), payments };
}
