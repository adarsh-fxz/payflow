import { getDb } from "@/lib/server/db";
import { handle, json, readJson } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session";
import { limitByIp } from "@/lib/server/ratelimit";
import { validateCsvSchema } from "@/lib/server/schemas";
import { validatePayrollCsv, validateRecipientCsv } from "@/lib/csv/validate";

/** ValidateCsvRequest (+ optional kind: "payroll" | "recipients") → CsvValidationReport. */
export async function POST(req: Request) {
  return handle(async () => {
    const db = getDb();
    await requireSession(db, req);
    await limitByIp(db, req, "csv");
    const body = await readJson(req, validateCsvSchema, 3 * 1024 * 1024);
    const opts = { employerBalanceWei: body.employerBalanceWei, maxAmount: body.maxAmountPerRow };
    return json(body.kind === "recipients" ? validateRecipientCsv(body.csv, opts) : validatePayrollCsv(body.csv, opts));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
