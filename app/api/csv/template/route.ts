import { z } from "zod";
import { csvResponse, handle, readQuery } from "@/lib/server/http";
import { PAYROLL_CSV_TEMPLATE, RECIPIENT_CSV_TEMPLATE } from "@/lib/csv/validate";

const schema = z.object({ kind: z.enum(["payroll", "recipients"]).default("payroll") });

export async function GET(req: Request) {
  return handle(async () => {
    const { kind } = readQuery(req, schema);
    return kind === "recipients"
      ? csvResponse(RECIPIENT_CSV_TEMPLATE, "payflow-recipients-template.csv")
      : csvResponse(PAYROLL_CSV_TEMPLATE, "payflow-payroll-template.csv");
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
