/**
 * Email via the Resend HTTP API, only when RESEND_API_KEY is set. Without a key nothing is sent and
 * the notification's email_status is 'skipped' (never a fake "sent").
 * Emails only ever contain the claim link; the contract checks msg.sender, so a forwarded link
 * cannot let another wallet claim.
 */
import "./guard";
import type { Db } from "./db";

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** `permanent`: retrying cannot help (4xx other than 408/429, missing key). */
export type SendResult = { ok: true; id: string | null } | { ok: false; error: string; permanent?: boolean };

export async function sendEmail(msg: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY not set", permanent: true };
  const from = process.env.EMAIL_FROM || "PayFlow <notifications@payflow.local>";
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      return { ok: false, error: `Resend ${res.status}: ${body.slice(0, 300)}`, permanent };
    }
    const j = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: j.id ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export function renderEmail(n: { title: string; body: string; link: string | null }): Omit<EmailMessage, "to"> {
  const url = n.link ? (n.link.startsWith("http") ? n.link : appUrl() + n.link) : null;
  const text = `${n.body}${url ? `\n\nOpen: ${url}` : ""}\n\nOnly the wallet the payment was sent to can claim it.\n— PayFlow`;
  const html =
    `<p>${escapeHtml(n.body)}</p>` +
    (url ? `<p><a href="${escapeHtml(url)}">Open in PayFlow</a></p>` : "") +
    `<p style="color:#666;font-size:12px">Only the wallet the payment was sent to can claim it.</p>`;
  return { subject: n.title, text, html };
}

interface OutboxRow {
  id: string;
  email: string;
  title: string;
  body: string;
  link: string | null;
}

export const EMAIL_MAX_ATTEMPTS = 5;
/** A row stuck in 'sending' (worker crashed mid-send) becomes claimable again after this lease. */
const SENDING_LEASE = "10 minutes";

/** Backoff before attempt n+1 (n = attempts so far): 1, 4, 16, 64 minutes. */
export function emailBackoffSeconds(attempts: number): number {
  return 60 * 4 ** Math.max(0, attempts - 1);
}

/**
 * Sends queued emails. Rows are leased atomically (queued → sending, attempts + 1) so concurrent
 * workers never double-send; a row becomes 'sent' only after Resend accepted it. A transient failure
 * goes back to 'queued' with exponential backoff; after EMAIL_MAX_ATTEMPTS (or a permanent 4xx) it is
 * 'failed' with the error kept.
 */
export async function sendOutbox(db: Db, limit = 25, fetchImpl: typeof fetch = fetch): Promise<{ sent: number; failed: number; skipped: number; retrying: number }> {
  if (!emailEnabled()) {
    const r = await db.query(`UPDATE notifications SET email_status = 'skipped' WHERE email_status = 'queued' RETURNING id`);
    return { sent: 0, failed: 0, skipped: r.length, retrying: 0 };
  }
  const rows = await db.query<OutboxRow & { email_attempts: number }>(
    `UPDATE notifications SET email_status = 'sending', email_attempts = email_attempts + 1, email_next_attempt_at = now() + interval '${SENDING_LEASE}'
     WHERE id IN (SELECT id FROM notifications
                  WHERE email IS NOT NULL AND (
                    (email_status = 'queued' AND (email_next_attempt_at IS NULL OR email_next_attempt_at <= now()))
                    OR (email_status = 'sending' AND email_next_attempt_at <= now()))
                  ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, email, title, body, link, email_attempts`,
    [limit],
  );
  let sent = 0;
  let failed = 0;
  let retrying = 0;
  for (const r of rows) {
    const res = await sendEmail({ to: r.email, ...renderEmail(r) }, fetchImpl);
    if (res.ok) {
      sent++;
      await db.query(`UPDATE notifications SET email_status = 'sent', email_error = NULL, email_next_attempt_at = NULL WHERE id = $1`, [r.id]);
    } else if (res.permanent || Number(r.email_attempts) >= EMAIL_MAX_ATTEMPTS) {
      failed++;
      await db.query(`UPDATE notifications SET email_status = 'failed', email_error = $2, email_next_attempt_at = NULL WHERE id = $1`, [r.id, res.error.slice(0, 500)]);
    } else {
      retrying++;
      await db.query(
        `UPDATE notifications SET email_status = 'queued', email_error = $2, email_next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`,
        [r.id, res.error.slice(0, 500), emailBackoffSeconds(Number(r.email_attempts))],
      );
    }
  }
  return { sent, failed, skipped: 0, retrying };
}
