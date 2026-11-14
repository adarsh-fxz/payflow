import { getDb } from "@/lib/server/db";
import { fail, handle, json, readJson } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session";
import { notificationsReadSchema } from "@/lib/server/schemas";

/** Body { ids?: string[], all?: boolean } → { updated }. */
export async function POST(req: Request) {
  return handle(async () => {
    const db = getDb();
    const wallet = await requireSession(db, req);
    const body = await readJson(req, notificationsReadSchema, 65536);
    if (!body.all && !body.ids?.length) throw fail("invalid_input", "Pass ids or all: true");
    const rows = body.all
      ? await db.query(`UPDATE notifications SET read_at = now() WHERE wallet_address = $1 AND read_at IS NULL RETURNING id`, [wallet])
      : await db.query(`UPDATE notifications SET read_at = now() WHERE wallet_address = $1 AND read_at IS NULL AND id = ANY($2::uuid[]) RETURNING id`, [wallet, `{${body.ids!.join(",")}}`]);
    return json({ updated: rows.length });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
