import { getDb } from "@/lib/server/db";
import { handle, json } from "@/lib/server/http";
import { clearSessionCookieHeader, destroySession, sessionToken } from "@/lib/server/session";
import type { SessionResponse } from "@/lib/api-types";

export async function POST(req: Request) {
  return handle(async () => {
    await destroySession(getDb(), sessionToken(req));
    return json({ address: null } satisfies SessionResponse, { headers: { "set-cookie": clearSessionCookieHeader(req) } });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
