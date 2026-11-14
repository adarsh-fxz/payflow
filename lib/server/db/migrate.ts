/**
 * Applies the frozen schema.sql (idempotent). CLI: `npm run db:migrate`
 * (DATABASE_URL → Postgres, otherwise PGlite at PGLITE_DIR / .data/pglite).
 */
import "../guard";
import { createPgliteDb, createPostgresDb, dbSchema, postgresSchemaSql, type Db } from "./index";
import { schemaSql } from "./schema-file";

export async function migrate(db: Db): Promise<void> {
  await db.exec(db.kind === "postgres" ? await postgresSchemaSql() : await schemaSql());
}

async function main() {
  const db = process.env.DATABASE_URL ? createPostgresDb(process.env.DATABASE_URL) : createPgliteDb(process.env.PGLITE_DIR || ".data/pglite");
  await migrate(db);
  const t = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1", [db.kind === "postgres" ? (dbSchema() ?? "public") : "public"]);
  console.log(JSON.stringify({ level: "info", msg: "migrated", driver: db.kind, schema: db.kind === "postgres" ? (dbSchema() ?? "public") : "public", tables: Number(t[0]?.n ?? 0) }));
  await db.close();
}

const isMain = typeof process !== "undefined" && process.argv[1] !== undefined && /migrate\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => {
    console.error(JSON.stringify({ level: "error", msg: "migration failed", error: e instanceof Error ? e.message : String(e) }));
    process.exit(1);
  });
}
