import { contracts, isDeployed, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { getDb, dbKind } from "@/lib/server/db";
import { handle, json } from "@/lib/server/http";
import { pingRpc } from "@/lib/server/chain";
import { getCursor } from "@/lib/server/indexer";
import type { Hex, HealthResponse } from "@/lib/api-types";

/** ok = DB reachable AND (contracts not deployed OR the RPC answers eth_blockNumber within ~3 s). */
export async function GET() {
  return handle(async () => {
    const [cursor, latest] = await Promise.all([
      getCursor(getDb()).then((v) => ({ ok: true as const, v }), () => ({ ok: false as const, v: null })),
      pingRpc(3_000),
    ]);
    const rpcOk = latest !== null;
    const ok = cursor.ok && (rpcOk || !isDeployed);
    const body: HealthResponse = {
      ok,
      rpc: rpcOk ? "ok" : "down",
      db: dbKind(),
      chainId: MEZO_TESTNET_ID,
      deployed: isDeployed,
      escrow: contracts.escrow.toLowerCase() as Hex,
      registry: contracts.registry.toLowerCase() as Hex,
      musd: contracts.musd.toLowerCase() as Hex,
      latestBlock: latest === null ? null : latest.toString(),
      indexedBlock: cursor.v === null ? null : cursor.v.toString(),
    };
    return json(body, { status: ok ? 200 : 503 });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
