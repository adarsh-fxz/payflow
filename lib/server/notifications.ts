import "./guard";
import type { NotificationKind } from "../api-types";
import { ROLE } from "../chain/config";
import type { Db } from "./db";
import { emailEnabled } from "./email";

export interface NewNotification {
  orgId: string | null;
  wallet: string | null;
  email?: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string | null;
  dedupeKey: string;
}

/** Idempotent insert (dedupe_key UNIQUE). Returns true when a new row was created. */
export async function notify(db: Db, n: NewNotification): Promise<boolean> {
  const email = n.email && n.email.includes("@") ? n.email.toLowerCase() : null;
  const emailStatus = email ? (emailEnabled() ? "queued" : "skipped") : "none";
  const rows = await db.query(
    `INSERT INTO notifications (id, organization_id, wallet_address, email, kind, title, body, link, dedupe_key, email_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [crypto.randomUUID(), n.orgId, n.wallet?.toLowerCase() ?? null, email, n.kind, n.title.slice(0, 200), n.body.slice(0, 2000), n.link ?? null, n.dedupeKey, emailStatus],
  );
  return rows.length > 0;
}

/**
 * Notifies employer-side members (owner + active members). `roleMask` limits to members holding
 * any of those bits (the owner always qualifies).
 */
export async function notifyEmployer(
  db: Db,
  orgId: string,
  base: Omit<NewNotification, "orgId" | "wallet" | "email" | "dedupeKey">,
  dedupeBase: string,
  roleMask = 0,
): Promise<number> {
  const members = await db.query<{ wallet: string; email: string | null }>(
    `SELECT o.owner_wallet AS wallet, o.owner_email AS email FROM organizations o WHERE o.id = $1
     UNION
     SELECT m.wallet_address AS wallet, m.email FROM organization_members m
       WHERE m.organization_id = $1 AND m.status = 'active' AND ($2::int = 0 OR (m.roles & $2::int) <> 0)`,
    [orgId, roleMask],
  );
  // The owner may also appear as a member row with an email; prefer the row that has one.
  const byWallet = new Map<string, string | null>();
  for (const m of members) if (!byWallet.has(m.wallet) || m.email) byWallet.set(m.wallet, m.email);
  let created = 0;
  for (const [wallet, email] of byWallet) {
    if (await notify(db, { ...base, orgId, wallet, email, dedupeKey: `${dedupeBase}:${wallet}` })) created++;
  }
  return created;
}

export const APPROVER_MASK = ROLE.APPROVER;
