import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { handle, json, readQuery } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session";
import { notificationDto, type NotificationRow } from "@/lib/server/dto";

const q = z.object({ unread: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

/** → Notification[] for the session wallet, newest first. */
export async function GET(req: Request) {
  return handle(async () => {
    const db = getDb();
    const wallet = await requireSession(db, req);
    const { unread, limit } = readQuery(req, q);
    const rows = await db.query<NotificationRow>(
      `SELECT id, kind, title, body, link, read_at, created_at FROM notifications
       WHERE wallet_address = $1 AND ($2::boolean = false OR read_at IS NULL) ORDER BY created_at DESC LIMIT $3`,
      [wallet, unread === "true", limit],
    );
    return json(rows.map(notificationDto));
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
