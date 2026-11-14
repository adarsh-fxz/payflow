import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { handle, json, readJson } from "@/lib/server/http";
import { limitByIp } from "@/lib/server/ratelimit";
import { createSession, expectedDomain, sessionCookieHeader, SESSION_TTL_SECONDS, verifySignIn } from "@/lib/server/session";
import type { Hex, SessionResponse } from "@/lib/api-types";

const schema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  message: z.string().min(1).max(2000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(4000),
});

export async function POST(req: Request) {
  return handle(async () => {
    const db = getDb();
    await limitByIp(db, req, "authVerify");
    const body = await readJson(req, schema, 8192);
    const address = await verifySignIn(db, { ...body, domain: expectedDomain(req) });
    const { token } = await createSession(db, address);
    const res: SessionResponse = { address: address as Hex };
    return json(res, { headers: { "set-cookie": sessionCookieHeader(req, token, SESSION_TTL_SECONDS) } });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
