import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { handle, json, readJson } from "@/lib/server/http";
import { limitByIp } from "@/lib/server/ratelimit";
import { createNonce, expectedDomain } from "@/lib/server/session";
import { zWallet } from "@/lib/server/schemas";
import type { NonceResponse } from "@/lib/api-types";

const schema = z.object({ address: zWallet });

export async function POST(req: Request) {
  return handle(async () => {
    const db = getDb();
    await limitByIp(db, req, "authNonce");
    const { address } = await readJson(req, schema, 4096);
    const n = await createNonce(db, address, expectedDomain(req));
    return json(n satisfies NonceResponse);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
