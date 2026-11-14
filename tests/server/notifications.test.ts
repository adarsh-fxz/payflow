import "./helpers/env";
import { afterEach, describe, expect, it } from "vitest";
import { notify } from "@/lib/server/notifications";
import { EMAIL_MAX_ATTEMPTS, emailBackoffSeconds, renderEmail, sendEmail, sendOutbox } from "@/lib/server/email";
import { freshDb } from "./helpers/db";

const W = "0x00000000000000000000000000000000000000b1";

afterEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe("notifications", () => {
  it("dedupe_key makes generation idempotent", async () => {
    const db = await freshDb();
    const n = { orgId: null, wallet: W, kind: "payment_available" as const, title: "t", body: "b", link: "/claim/1", dedupeKey: "k1" };
    expect(await notify(db, n)).toBe(true);
    expect(await notify(db, n)).toBe(false);
    expect(await notify(db, { ...n, dedupeKey: "k2" })).toBe(true);
    const rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications`);
    expect(rows[0]!.n).toBe("2");
    await db.close();
  });

  it("email is skipped (never fake-sent) when RESEND_API_KEY is not set", async () => {
    const db = await freshDb();
    await notify(db, { orgId: null, wallet: W, email: "a@example.com", kind: "payment_received", title: "t", body: "b", dedupeKey: "e1" });
    await notify(db, { orgId: null, wallet: W, email: null, kind: "payment_received", title: "t", body: "b", dedupeKey: "e2" });
    const rows = await db.query<{ dedupe_key: string; email_status: string }>(`SELECT dedupe_key, email_status FROM notifications ORDER BY dedupe_key`);
    expect(rows).toEqual([{ dedupe_key: "e1", email_status: "skipped" }, { dedupe_key: "e2", email_status: "none" }]);
    expect(await sendEmail({ to: "a@example.com", subject: "s", text: "t", html: "h" })).toMatchObject({ ok: false, error: "RESEND_API_KEY not set" });
    await db.close();
  });

  it("with a key, the outbox sends each queued email once and records failures", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const db = await freshDb();
    await notify(db, { orgId: null, wallet: W, email: "ok@example.com", kind: "payment_available", title: "Paid", body: "You were paid", link: "/claim/42", dedupeKey: "q1" });
    await notify(db, { orgId: null, wallet: W, email: "bad@example.com", kind: "payment_available", title: "Paid", body: "x", link: null, dedupeKey: "q2" });
    const sent: { to: string[]; text: string }[] = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { to: string[]; text: string };
      sent.push(body);
      return body.to[0] === "bad@example.com" ? new Response("nope", { status: 422 }) : new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as typeof fetch;
    // 422 is permanent (no retry); a sent row is never re-sent.
    expect(await sendOutbox(db, 25, fakeFetch)).toEqual({ sent: 1, failed: 1, skipped: 0, retrying: 0 });
    expect(await sendOutbox(db, 25, fakeFetch)).toEqual({ sent: 0, failed: 0, skipped: 0, retrying: 0 });
    expect(sent).toHaveLength(2);
    expect(sent.find((m) => m.to[0] === "ok@example.com")!.text).toContain("/claim/42");
    const rows = await db.query<{ dedupe_key: string; email_status: string; email_error: string | null }>(`SELECT dedupe_key, email_status, email_error FROM notifications ORDER BY dedupe_key`);
    expect(rows[0]).toMatchObject({ dedupe_key: "q1", email_status: "sent" });
    expect(rows[1]).toMatchObject({ dedupe_key: "q2", email_status: "failed" });
    expect(rows[1]!.email_error).toMatch(/422/);
    await db.close();
  });

  it("transient failures are retried with backoff up to EMAIL_MAX_ATTEMPTS; 'sent' only after success", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const db = await freshDb();
    await notify(db, { orgId: null, wallet: W, email: "flaky@example.com", kind: "payment_available", title: "Paid", body: "x", link: null, dedupeKey: "r1" });
    let calls = 0;
    let statusDuringSend = "";
    const down = (async () => {
      calls++;
      statusDuringSend = (await db.query<{ email_status: string }>(`SELECT email_status FROM notifications WHERE dedupe_key = 'r1'`))[0]!.email_status;
      return new Response("busy", { status: 503 });
    }) as typeof fetch;
    const due = () => db.query(`UPDATE notifications SET email_next_attempt_at = now() - interval '1 second' WHERE dedupe_key = 'r1'`);
    expect(await sendOutbox(db, 25, down)).toMatchObject({ sent: 0, failed: 0, retrying: 1 });
    expect(statusDuringSend).toBe("sending");
    let row = (await db.query<{ email_status: string; email_attempts: number; email_next_attempt_at: Date }>(`SELECT email_status, email_attempts, email_next_attempt_at FROM notifications WHERE dedupe_key = 'r1'`))[0]!;
    expect(row).toMatchObject({ email_status: "queued", email_attempts: 1 });
    expect(new Date(row.email_next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Not due yet → not retried.
    expect(await sendOutbox(db, 25, down)).toMatchObject({ retrying: 0 });
    expect(calls).toBe(1);
    for (let i = 2; i <= EMAIL_MAX_ATTEMPTS; i++) {
      await due();
      await sendOutbox(db, 25, down);
    }
    expect(calls).toBe(EMAIL_MAX_ATTEMPTS);
    row = (await db.query<{ email_status: string; email_attempts: number; email_next_attempt_at: Date }>(`SELECT email_status, email_attempts, email_next_attempt_at FROM notifications WHERE dedupe_key = 'r1'`))[0]!;
    expect(row).toMatchObject({ email_status: "failed", email_attempts: EMAIL_MAX_ATTEMPTS });
    // Recovery path: a queued row that succeeds on retry ends 'sent'.
    await notify(db, { orgId: null, wallet: W, email: "later@example.com", kind: "payment_available", title: "Paid", body: "x", link: null, dedupeKey: "r2" });
    await sendOutbox(db, 25, down);
    await db.query(`UPDATE notifications SET email_next_attempt_at = now() - interval '1 second' WHERE dedupe_key = 'r2'`);
    const ok = (async () => new Response(JSON.stringify({ id: "em" }), { status: 200 })) as typeof fetch;
    expect(await sendOutbox(db, 25, ok)).toMatchObject({ sent: 1 });
    expect((await db.query<{ email_status: string }>(`SELECT email_status FROM notifications WHERE dedupe_key = 'r2'`))[0]!.email_status).toBe("sent");
    expect(emailBackoffSeconds(1)).toBe(60);
    expect(emailBackoffSeconds(3)).toBe(960);
    await db.close();
  });

  it("emails carry only the claim link and escape HTML", () => {
    const e = renderEmail({ title: "T", body: "<script>x</script>", link: "/claim/7" });
    expect(e.html).not.toContain("<script>");
    expect(e.text).toMatch(/\/claim\/7/);
    expect(e.text).toMatch(/Only the wallet/);
  });
});
