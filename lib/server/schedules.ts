/**
 * Recurring payroll templates. Generation only ever creates an off-chain draft run (never sends a
 * transaction or moves funds), re-validated against the org's active recipients.
 */
import "./guard";
import type { z } from "zod";
import type { PayrollRunDetail, Schedule } from "../api-types";
import { ROLE } from "../chain/config";
import type { Db } from "./db";
import { fail, parseUuid } from "./http";
import { scheduleDto, type ScheduleRow, type RecipientRow } from "./dto";
import { audit } from "./audit";
import { loadOrg, type OrgRow } from "./authz";
import { createRun } from "./runs";
import { notifyEmployer } from "./notifications";
import { links } from "./links";
import type { scheduleInputSchema } from "./schemas";

export type ScheduleFrequency = "weekly" | "biweekly" | "monthly";
const DAY = 86_400_000;

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** First occurrence strictly after `now` (dates are UTC midnight). */
export function firstRunAt(freq: ScheduleFrequency, dayOfMonth: number | null, weekday: number | null, now: Date): Date {
  if (freq === "monthly") {
    const d = clampDay(dayOfMonth);
    let c = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d));
    if (c.getTime() <= now.getTime()) c = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, d));
    return c;
  }
  const wd = clampWeekday(weekday);
  const today = utcMidnight(now);
  let c = new Date(today.getTime() + ((wd - today.getUTCDay() + 7) % 7) * DAY);
  if (c.getTime() <= now.getTime()) c = new Date(c.getTime() + 7 * DAY);
  return c;
}

/** The occurrence after `current`: +7d, +14d, or the same day next month. */
export function advanceRunAt(freq: ScheduleFrequency, dayOfMonth: number | null, current: Date): Date {
  if (freq === "weekly") return new Date(current.getTime() + 7 * DAY);
  if (freq === "biweekly") return new Date(current.getTime() + 14 * DAY);
  const d = clampDay(dayOfMonth ?? current.getUTCDate());
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, d));
}

/** Advances past `now` (skips missed periods without generating a backlog). */
export function nextRunAfter(freq: ScheduleFrequency, dayOfMonth: number | null, current: Date, now: Date): Date {
  let c = advanceRunAt(freq, dayOfMonth, current);
  for (let i = 0; i < 1000 && c.getTime() <= now.getTime(); i++) c = advanceRunAt(freq, dayOfMonth, c);
  return c;
}

function clampDay(d: number | null): number {
  if (d == null || !Number.isInteger(d) || d < 1 || d > 28) throw fail("invalid_input", "dayOfMonth must be 1..28 for monthly schedules");
  return d;
}
function clampWeekday(w: number | null): number {
  if (w == null || !Number.isInteger(w) || w < 0 || w > 6) throw fail("invalid_input", "weekday must be 0..6 (Sunday = 0) for weekly schedules");
  return w;
}

type ScheduleInput = z.infer<typeof scheduleInputSchema>;

async function checkScheduleItems(db: Db, orgId: string, items: ScheduleInput["items"]): Promise<void> {
  const ids = items.map((i) => i.recipientId);
  if (new Set(ids).size !== ids.length) throw fail("invalid_input", "A recipient appears more than once in the schedule");
  const found = await db.query<{ id: string }>(`SELECT id FROM recipients WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [orgId, `{${ids.join(",")}}`]);
  const ok = new Set(found.map((f) => f.id));
  const bad = ids.filter((id) => !ok.has(id));
  if (bad.length) throw fail("invalid_input", "Some recipients do not belong to this organization", { recipientIds: bad });
}

const itemsJson = (items: ScheduleInput["items"]) => JSON.stringify(items.map((i) => ({ recipient_id: i.recipientId, amount: i.amount, description: i.description })));

export async function listSchedules(db: Db, orgId: string): Promise<Schedule[]> {
  const rows = await db.query<ScheduleRow>(`SELECT * FROM payroll_schedules WHERE organization_id = $1 ORDER BY active DESC, next_run_at`, [orgId]);
  return rows.map(scheduleDto);
}

export async function loadSchedule(db: Db, orgId: string, id: string): Promise<ScheduleRow> {
  const rows = await db.query<ScheduleRow>(`SELECT * FROM payroll_schedules WHERE id = $1 AND organization_id = $2`, [parseUuid(id, "Schedule"), orgId]);
  if (!rows[0]) throw fail("not_found", "Schedule not found");
  return rows[0];
}

export async function createSchedule(db: Db, actor: string, orgId: string, input: ScheduleInput, now = new Date()): Promise<Schedule> {
  await checkScheduleItems(db, orgId, input.items);
  const dom = input.frequency === "monthly" ? input.dayOfMonth ?? null : null;
  const wd = input.frequency === "monthly" ? null : input.weekday ?? null;
  const next = firstRunAt(input.frequency, dom, wd, now);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO payroll_schedules (id, organization_id, name, payment_category, frequency, day_of_month, weekday, items_json, next_run_at, active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
    [id, orgId, input.name, input.paymentCategory, input.frequency, dom, wd, itemsJson(input.items), next, input.active ?? true, actor],
  );
  await audit(db, { orgId, actor, action: "schedule.create", resourceId: id, metadata: { name: input.name, frequency: input.frequency } });
  return scheduleDto(await loadSchedule(db, orgId, id));
}

export async function updateSchedule(db: Db, actor: string, orgId: string, id: string, patch: Partial<ScheduleInput>, now = new Date()): Promise<Schedule> {
  const cur = await loadSchedule(db, orgId, id);
  if (patch.items) await checkScheduleItems(db, orgId, patch.items);
  const freq = (patch.frequency ?? cur.frequency) as ScheduleFrequency;
  const dom = freq === "monthly" ? (patch.dayOfMonth !== undefined ? patch.dayOfMonth : cur.day_of_month) : null;
  const wd = freq === "monthly" ? null : patch.weekday !== undefined ? patch.weekday : cur.weekday;
  const timingChanged = patch.frequency !== undefined || patch.dayOfMonth !== undefined || patch.weekday !== undefined;
  const reactivated = patch.active === true && !cur.active;
  const next = timingChanged || reactivated ? firstRunAt(freq, dom ?? null, wd ?? null, now) : cur.next_run_at;
  await db.query(
    `UPDATE payroll_schedules SET name = $3, payment_category = $4, frequency = $5, day_of_month = $6, weekday = $7,
       items_json = COALESCE($8::jsonb, items_json), next_run_at = $9, active = $10
     WHERE id = $1 AND organization_id = $2`,
    [cur.id, orgId, patch.name ?? cur.name, patch.paymentCategory ?? cur.payment_category, freq, dom ?? null, wd ?? null, patch.items ? itemsJson(patch.items) : null, next, patch.active ?? cur.active],
  );
  await audit(db, { orgId, actor, action: "schedule.update", resourceId: cur.id, metadata: { fields: Object.keys(patch) } });
  return scheduleDto(await loadSchedule(db, orgId, cur.id));
}

export async function deleteSchedule(db: Db, actor: string, orgId: string, id: string): Promise<void> {
  const cur = await loadSchedule(db, orgId, id);
  await db.query(`DELETE FROM payroll_schedules WHERE id = $1`, [cur.id]);
  await audit(db, { orgId, actor, action: "schedule.delete", resourceId: cur.id, metadata: { name: cur.name } });
}

export interface GenerateResult {
  run: PayrollRunDetail;
  skipped: { recipientId: string; reason: "inactive" | "missing" }[];
}

/** Builds a draft run from the schedule's items, excluding recipients that are inactive or gone. */
export async function generateDraft(db: Db, actor: string, org: OrgRow, s: ScheduleRow, forDate: Date): Promise<GenerateResult> {
  const items = Array.isArray(s.items_json) ? s.items_json : [];
  const ids = items.map((i) => i.recipient_id);
  const recipients = ids.length
    ? await db.query<RecipientRow>(`SELECT * FROM recipients WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [org.id, `{${ids.join(",")}}`])
    : [];
  const byId = new Map(recipients.map((r) => [r.id, r]));
  const skipped: GenerateResult["skipped"] = [];
  const runItems = [];
  for (const it of items) {
    const r = byId.get(it.recipient_id);
    if (!r) skipped.push({ recipientId: it.recipient_id, reason: "missing" });
    else if (r.status !== "active") skipped.push({ recipientId: it.recipient_id, reason: "inactive" });
    else
      runItems.push({
        recipientId: r.id,
        name: r.name,
        email: r.email,
        department: r.department,
        walletAddress: r.wallet_address as `0x${string}`,
        amount: BigInt(String(it.amount)).toString(),
        description: it.description ?? "",
      });
  }
  if (runItems.length === 0) throw fail("conflict", "No active recipients left in this schedule", { skipped });
  const date = forDate.toISOString().slice(0, 10);
  const run = await createRun(
    db,
    actor,
    org,
    {
      name: `${s.name} (${date})`,
      paymentCategory: s.payment_category,
      frequency: s.frequency === "monthly" ? "monthly" : "one_time",
      scheduledAt: forDate.toISOString(),
      claimWindowDays: Number(org.default_claim_window_days),
      items: runItems,
    },
    { scheduleId: s.id },
  );
  await db.query(`UPDATE payroll_schedules SET last_generated_at = now() WHERE id = $1`, [s.id]);
  await audit(db, { orgId: org.id, actor, action: "schedule.generate", resourceId: run.id, metadata: { scheduleId: s.id, name: run.name, skipped: skipped.length, amountWei: run.totalAmount } });
  await notifyEmployer(
    db,
    org.id,
    { kind: "schedule_draft_created", title: "Scheduled payroll draft ready", body: `A draft for "${s.name}" (${date}) is ready to review.${skipped.length ? ` ${skipped.length} inactive recipient(s) were left out.` : ""}`, link: links.run(org.id, run.id) },
    `schedule_draft:${s.id}:${date}:${run.id}`,
    ROLE.OPERATOR | ROLE.ADMIN,
  );
  return { run, skipped };
}

/**
 * Worker: generates drafts for every due schedule. Each schedule is claimed atomically by moving
 * next_run_at forward (WHERE next_run_at = old), so concurrent workers never generate twice.
 */
export async function generateDueSchedules(db: Db, now = new Date()): Promise<{ generated: number; failed: number }> {
  const due = await db.query<ScheduleRow>(`SELECT * FROM payroll_schedules WHERE active = true AND next_run_at <= $1 ORDER BY next_run_at LIMIT 50`, [now]);
  let generated = 0;
  let failed = 0;
  for (const s of due) {
    const next = nextRunAfter(s.frequency as ScheduleFrequency, s.day_of_month, new Date(s.next_run_at), now);
    const claimed = await db.query(`UPDATE payroll_schedules SET next_run_at = $3 WHERE id = $1 AND next_run_at = $2 RETURNING id`, [s.id, s.next_run_at, next]);
    if (!claimed.length) continue;
    try {
      const org = await loadOrg(db, s.organization_id);
      await generateDraft(db, "system", org, s, new Date(s.next_run_at));
      generated++;
    } catch (e) {
      failed++;
      await audit(db, { orgId: s.organization_id, actor: "system", action: "schedule.generate_failed", resourceId: s.id, metadata: { error: e instanceof Error ? e.message : String(e) } });
    }
  }
  return { generated, failed };
}
