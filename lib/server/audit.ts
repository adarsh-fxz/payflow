import "./guard";
import type { Db } from "./db";

export async function audit(
  db: Db,
  e: { orgId: string | null; actor: string; action: string; resourceId?: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (id, organization_id, actor_wallet, action, resource_id, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [crypto.randomUUID(), e.orgId, e.actor.toLowerCase(), e.action, e.resourceId ?? null, JSON.stringify(e.metadata ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v))],
  );
}
