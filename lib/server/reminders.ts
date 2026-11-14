import "./guard";
import { ROLE } from "../chain/config";
import { weiToDecimalString } from "../money";
import type { Db } from "./db";
import { notify, notifyEmployer } from "./notifications";
import { links } from "./links";
import { notifyPaymentsAvailable } from "./lifecycle";

export const REMINDER_WINDOW_HOURS = 72;

/**
 * Claim-expiry reminders (72h before claim_deadline) to unclaimed recipients and the employer. Idempotent.
 * A recipient is only reminded after their payment_available notice exists (it is backfilled first,
 * so the "you were paid" notice always precedes the reminder).
 */
export async function sendExpiryReminders(db: Db, now = new Date()): Promise<{ recipients: number; employers: number }> {
  const until = new Date(now.getTime() + REMINDER_WINDOW_HOURS * 3600_000);
  const runs = await db.query<{ id: string; organization_id: string; name: string; claim_deadline: Date; org_name: string }>(
    `SELECT r.id, r.organization_id, r.name, r.claim_deadline, o.name AS org_name FROM payroll_runs r JOIN organizations o ON o.id = r.organization_id
     WHERE r.status IN ('published', 'partially_claimed') AND r.claim_deadline > $1 AND r.claim_deadline <= $2`,
    [now, until],
  );
  let recipients = 0;
  let employers = 0;
  for (const run of runs) {
    await notifyPaymentsAvailable(db, run.id, now);
    const items = await db.query<{ payment_id: string; recipient_address: string; email: string | null; amount: string }>(
      `SELECT i.payment_id::text AS payment_id, i.recipient_address, i.email, i.amount::text AS amount FROM payroll_items i
       WHERE i.payroll_run_id = $1 AND i.claim_status = 'allocated' AND i.payment_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM notifications n WHERE n.dedupe_key = 'payment_available:' || i.payment_id::text)`,
      [run.id],
    );
    if (items.length === 0) continue;
    const deadline = new Date(run.claim_deadline).toUTCString();
    for (const it of items) {
      const created = await notify(db, {
        orgId: run.organization_id, wallet: it.recipient_address, email: it.email, kind: "payment_reminder",
        title: `Claim your ${weiToDecimalString(it.amount)} MUSD before ${deadline}`,
        body: `Your payment of ${weiToDecimalString(it.amount)} MUSD from ${run.org_name} is still unclaimed. The claim window closes ${deadline}.`,
        link: links.claim(it.payment_id), dedupeKey: `payment_reminder:${it.payment_id}`,
      });
      if (created) recipients++;
    }
    const total = items.reduce((a, i) => a + BigInt(i.amount), 0n);
    employers += await notifyEmployer(
      db, run.organization_id,
      { kind: "claims_expiring", title: "Unclaimed payments expiring soon", body: `${items.length} payment(s) totalling ${weiToDecimalString(total)} MUSD in "${run.name}" are unclaimed. The claim window closes ${deadline}.`, link: links.run(run.organization_id, run.id) },
      `claims_expiring:${run.id}`, ROLE.ADMIN,
    );
  }
  return { recipients, employers };
}
