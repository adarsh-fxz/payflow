import { getDb } from "@/lib/server/db";
import { handle, json } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session";
import { myPayments } from "@/lib/server/claims";

export async function GET(req: Request) {
  return handle(async () => {
    const db = getDb();
    return json(await myPayments(db, await requireSession(db, req)));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
