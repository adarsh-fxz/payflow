import "./helpers/env";
import { describe, expect, it } from "vitest";
import { advanceRunAt, createSchedule, firstRunAt, generateDueSchedules, nextRunAfter } from "@/lib/server/schedules";
import { createOrg } from "@/lib/server/orgs";
import { createRecipient } from "@/lib/server/recipients";
import { freshDb } from "./helpers/db";

const d = (s: string) => new Date(s);

describe("schedule date math (UTC)", () => {
  it("monthly: this month's day if still ahead, else next month", () => {
    expect(firstRunAt("monthly", 15, null, d("2026-11-09T10:00:00Z")).toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(firstRunAt("monthly", 9, null, d("2026-11-09T10:00:00Z")).toISOString()).toBe("2026-12-09T00:00:00.000Z");
    expect(firstRunAt("monthly", 1, null, d("2026-12-20T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(advanceRunAt("monthly", 28, d("2027-01-28T00:00:00Z")).toISOString()).toBe("2027-02-28T00:00:00.000Z");
  });

  it("weekly / biweekly: next matching weekday strictly after now", () => {
    // 2026-11-09 is a Monday (1).
    expect(firstRunAt("weekly", null, 5, d("2026-11-09T10:00:00Z")).toISOString()).toBe("2026-11-13T00:00:00.000Z");
    expect(firstRunAt("weekly", null, 1, d("2026-11-09T10:00:00Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(firstRunAt("biweekly", null, 0, d("2026-11-09T00:00:00Z")).toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(advanceRunAt("weekly", null, d("2026-11-13T00:00:00Z")).toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(advanceRunAt("biweekly", null, d("2026-11-13T00:00:00Z")).toISOString()).toBe("2026-11-27T00:00:00.000Z");
  });

  it("skips missed periods without a backlog", () => {
    expect(nextRunAfter("weekly", null, d("2026-10-01T00:00:00Z"), d("2026-11-09T12:00:00Z")).toISOString()).toBe("2026-11-12T00:00:00.000Z");
    expect(nextRunAfter("monthly", 5, d("2026-07-05T00:00:00Z"), d("2026-11-09T00:00:00Z")).toISOString()).toBe("2026-12-05T00:00:00.000Z");
  });

  it("rejects invalid day/weekday", () => {
    expect(() => firstRunAt("monthly", 31, null, new Date())).toThrow(/1..28/);
    expect(() => firstRunAt("weekly", null, 7, new Date())).toThrow(/0..6/);
  });
});

describe("schedule → draft generation", () => {
  it("creates one off-chain draft per due period, excluding inactive recipients", async () => {
    const db = await freshDb();
    const owner = "0x00000000000000000000000000000000000000c1";
    const org = await createOrg(db, owner, { name: "Sched Co", description: "", logoUrl: null, treasuryWallet: null, defaultClaimWindowDays: 14 });
    const base = { email: null, externalId: null, department: null, paymentCategory: null, paymentFrequency: null, defaultAmount: null };
    const a = await createRecipient(db, owner, org.id, { ...base, name: "A", walletAddress: "0x00000000000000000000000000000000000000d1" });
    const b = await createRecipient(db, owner, org.id, { ...base, name: "B", walletAddress: "0x00000000000000000000000000000000000000d2", status: "inactive" });
    const now = d("2026-11-09T10:00:00Z");
    const s = await createSchedule(db, owner, org.id, {
      name: "Monthly",
      paymentCategory: "salary",
      frequency: "monthly",
      dayOfMonth: 10,
      items: [{ recipientId: a.id, amount: "1000000000000000000", description: "pay" }, { recipientId: b.id, amount: "2000000000000000000", description: "" }],
    }, now);
    expect(s.nextRunAt).toBe("2026-11-10T00:00:00.000Z");
    expect(s.totalWei).toBe("3000000000000000000");

    expect(await generateDueSchedules(db, now)).toEqual({ generated: 0, failed: 0 });
    const later = d("2026-11-10T01:00:00Z");
    const [r1, r2] = await Promise.all([generateDueSchedules(db, later), generateDueSchedules(db, later)]);
    expect(r1.generated + r2.generated).toBe(1);

    const runs = await db.query<{ status: string; chain_run_id: string | null; total_amount: string; recipient_count: number; claim_window_days: number; schedule_id: string }>(`SELECT * FROM payroll_runs`);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "draft", chain_run_id: null, recipient_count: 1, claim_window_days: 14, schedule_id: s.id });
    expect(String(runs[0]!.total_amount)).toBe("1000000000000000000");
    const next = await db.query<{ next_run_at: Date }>(`SELECT next_run_at FROM payroll_schedules WHERE id = $1`, [s.id]);
    expect(next[0]!.next_run_at.toISOString()).toBe("2026-12-10T00:00:00.000Z");
    const notes = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE kind = 'schedule_draft_created'`);
    expect(notes[0]!.n).toBe("1");
    await db.close();
  });
});
