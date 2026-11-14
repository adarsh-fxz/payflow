import { getDb } from "@/lib/server/db";
import { handle, json, readJson } from "@/lib/server/http";
import { requireSession } from "@/lib/server/session";
import { createOrg, listMyOrgs } from "@/lib/server/orgs";
import { createOrgSchema } from "@/lib/server/schemas";

export async function GET(req: Request) {
  return handle(async () => {
    const db = getDb();
    const wallet = await requireSession(db, req);
    return json(await listMyOrgs(db, wallet));
  });
}

export async function POST(req: Request) {
  return handle(async () => {
    const db = getDb();
    const wallet = await requireSession(db, req);
    const input = await readJson(req, createOrgSchema);
    return json(await createOrg(db, wallet, input), { status: 201 });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
