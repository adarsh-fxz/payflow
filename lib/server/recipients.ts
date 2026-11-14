import "./guard";
import type { z } from "zod";
import type { CsvValidationReport, Paginated, Recipient } from "../api-types";
import { parseRecipientCsv, toCsv } from "../csv/validate";
import { weiToDecimalString } from "../money";
import type { Db } from "./db";
import { fail, parseUuid } from "./http";
import { recipientDto, type RecipientRow } from "./dto";
import { audit } from "./audit";
import type { recipientInputSchema, recipientPatchSchema, recipientQuerySchema } from "./schemas";

const SELECT = `SELECT r.*, (SELECT max(i.claimed_at) FROM payroll_items i JOIN payroll_runs pr ON pr.id = i.payroll_run_id
                  WHERE pr.organization_id = r.organization_id AND i.recipient_address = r.wallet_address AND i.claim_status = 'claimed') AS last_paid_at
                FROM recipients r`;

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function listRecipients(db: Db, orgId: string, q: z.infer<typeof recipientQuerySchema>): Promise<Paginated<Recipient>> {
  const where: string[] = ["r.organization_id = $1"];
  const params: unknown[] = [orgId];
  if (q.q) {
    params.push(likePattern(q.q));
    const p = `$${params.length}`;
    where.push(`(r.name ILIKE ${p} OR r.email ILIKE ${p} OR r.wallet_address ILIKE ${p} OR r.external_id ILIKE ${p})`);
  }
  if (q.department) {
    params.push(q.department);
    where.push(`r.department = $${params.length}`);
  }
  if (q.status && q.status !== "all") {
    params.push(q.status);
    where.push(`r.status = $${params.length}`);
  }
  const w = where.join(" AND ");
  const total = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM recipients r WHERE ${w}`, params);
  params.push(q.pageSize, (q.page - 1) * q.pageSize);
  const rows = await db.query<RecipientRow>(
    `${SELECT} WHERE ${w} ORDER BY r.status, lower(r.name), r.created_at LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows.map(recipientDto), total: Number(total[0]?.n ?? 0), page: q.page, pageSize: q.pageSize };
}

export async function getRecipient(db: Db, orgId: string, id: string): Promise<RecipientRow> {
  const rows = await db.query<RecipientRow>(`${SELECT} WHERE r.id = $1 AND r.organization_id = $2`, [parseUuid(id, "Recipient"), orgId]);
  if (!rows[0]) throw fail("not_found", "Recipient not found");
  return rows[0];
}

async function assertWalletFree(db: Db, orgId: string, wallet: string, exceptId?: string) {
  const r = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM recipients WHERE organization_id = $1 AND wallet_address = $2 AND id <> $3`,
    [orgId, wallet, exceptId ?? "00000000-0000-0000-0000-000000000000"],
  );
  if (r[0]) throw fail("conflict", `Wallet already belongs to recipient "${r[0].name}"`, { recipientId: r[0].id });
}

export async function createRecipient(db: Db, actor: string, orgId: string, input: z.infer<typeof recipientInputSchema>): Promise<Recipient> {
  await assertWalletFree(db, orgId, input.walletAddress);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO recipients (id, organization_id, name, email, wallet_address, external_id, department, payment_category, payment_frequency, default_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, orgId, input.name, input.email, input.walletAddress, input.externalId, input.department, input.paymentCategory, input.paymentFrequency, input.defaultAmount, input.status ?? "active"],
  );
  await audit(db, { orgId, actor, action: "recipient.create", resourceId: id, metadata: { wallet: input.walletAddress } });
  return recipientDto(await getRecipient(db, orgId, id));
}

export async function updateRecipient(db: Db, actor: string, orgId: string, id: string, input: z.infer<typeof recipientPatchSchema>): Promise<Recipient> {
  const cur = await getRecipient(db, orgId, id);
  if (input.walletAddress && input.walletAddress !== cur.wallet_address) await assertWalletFree(db, orgId, input.walletAddress, cur.id);
  const pick = <T,>(v: T | undefined, d: T) => (v === undefined ? d : v);
  await db.query(
    `UPDATE recipients SET name = $3, email = $4, wallet_address = $5, external_id = $6, department = $7, payment_category = $8,
       payment_frequency = $9, default_amount = $10, status = $11, updated_at = now()
     WHERE id = $1 AND organization_id = $2`,
    [
      cur.id,
      orgId,
      pick(input.name, cur.name),
      pick(input.email, cur.email),
      pick(input.walletAddress, cur.wallet_address),
      input.externalId === undefined ? cur.external_id : input.externalId || null,
      input.department === undefined ? cur.department : input.department || null,
      pick(input.paymentCategory, cur.payment_category),
      pick(input.paymentFrequency, cur.payment_frequency),
      input.defaultAmount === undefined ? cur.default_amount : input.defaultAmount || null,
      pick(input.status, cur.status),
    ],
  );
  await audit(db, { orgId, actor, action: "recipient.update", resourceId: cur.id, metadata: { fields: Object.keys(input) } });
  return recipientDto(await getRecipient(db, orgId, cur.id));
}

export async function deactivateRecipient(db: Db, actor: string, orgId: string, id: string): Promise<Recipient> {
  const cur = await getRecipient(db, orgId, id);
  await db.query(`UPDATE recipients SET status = 'inactive', updated_at = now() WHERE id = $1`, [cur.id]);
  await audit(db, { orgId, actor, action: "recipient.deactivate", resourceId: cur.id });
  return recipientDto(await getRecipient(db, orgId, cur.id));
}

export interface ImportResult {
  imported: number;
  updated: number;
  report: CsvValidationReport;
}

/** All-or-nothing: any row/file error → invalid_input with the full report in details. Upserts by wallet. */
export async function importRecipients(db: Db, actor: string, orgId: string, csv: string): Promise<ImportResult> {
  const { report, extras } = parseRecipientCsv(csv);
  const blocking = report.fileIssues.some((i) => i.severity === "error") || report.invalidRows > 0 || report.totalRows === 0;
  if (blocking) throw fail("invalid_input", `CSV has ${report.invalidRows} invalid row(s); fix them and re-upload`, report);
  let imported = 0;
  let updated = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < report.rows.length; i++) {
      const r = report.rows[i]!;
      const ex = extras[i]!;
      const wallet = r.walletAddress.toLowerCase();
      const existing = await tx.query<{ id: string }>(`SELECT id FROM recipients WHERE organization_id = $1 AND wallet_address = $2`, [orgId, wallet]);
      if (existing[0]) {
        await tx.query(
          `UPDATE recipients SET name = $2, email = COALESCE($3, email), external_id = COALESCE($4, external_id), department = COALESCE($5, department),
             payment_category = COALESCE($6, payment_category), payment_frequency = COALESCE($7, payment_frequency),
             default_amount = COALESCE($8, default_amount), status = 'active', updated_at = now()
           WHERE id = $1`,
          [existing[0].id, r.name, r.email, ex.externalId, r.department, ex.paymentCategory, ex.paymentFrequency, r.amountWei],
        );
        updated++;
      } else {
        await tx.query(
          `INSERT INTO recipients (id, organization_id, name, email, wallet_address, external_id, department, payment_category, payment_frequency, default_amount, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')`,
          [crypto.randomUUID(), orgId, r.name, r.email, wallet, ex.externalId, r.department, ex.paymentCategory, ex.paymentFrequency, r.amountWei],
        );
        imported++;
      }
    }
    await audit(tx, { orgId, actor, action: "recipient.import", metadata: { imported, updated, rows: report.totalRows } });
  });
  return { imported, updated, report };
}

export async function exportRecipientsCsv(db: Db, orgId: string): Promise<string> {
  const rows = await db.query<RecipientRow>(`${SELECT} WHERE r.organization_id = $1 ORDER BY lower(r.name)`, [orgId]);
  return toCsv(
    rows.map((r) => ({
      name: r.name,
      email: r.email,
      wallet_address: r.wallet_address,
      amount: r.default_amount == null ? "" : weiToDecimalString(String(r.default_amount)),
      department: r.department,
      external_id: r.external_id,
      payment_category: r.payment_category,
      payment_frequency: r.payment_frequency,
      status: r.status,
      last_paid_at: r.last_paid_at ?? null,
    })),
    ["name", "email", "wallet_address", "amount", "department", "external_id", "payment_category", "payment_frequency", "status", "last_paid_at"],
  );
}
