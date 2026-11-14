import { getDb } from "@/lib/server/db";
import { handle, json } from "@/lib/server/http";
import { getSessionAddress } from "@/lib/server/session";
import type { Hex, SessionResponse } from "@/lib/api-types";

export async function GET(req: Request) {
  return handle(async () => {
    const address = await getSessionAddress(getDb(), req);
    return json({ address: (address as Hex | null) ?? null } satisfies SessionResponse);
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
