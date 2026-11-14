/**
 * Database access behind one small interface:
 *  - postgres.js when DATABASE_URL is set,
 *  - PGlite (embedded Postgres, WASM) at PGLITE_DIR (default .data/pglite) otherwise.
 * The frozen schema.sql is applied idempotently on first use.
 *
 * Normalisation (both drivers): numeric/int8 → string, timestamptz → Date, jsonb → object.
 * Pass jsonb params as JSON text with `$n::jsonb`. Parameterized queries only.
 */
import "../guard";
import postgres from "postgres";
import { schemaSql } from "./schema-file";

export type Row = Record<string, unknown>;

export interface Db {
  readonly kind: "postgres" | "pglite";
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Multi-statement SQL without parameters (migrations only). */
  exec(sqlText: string): Promise<void>;
  /** Runs fn in a transaction. Inside fn use ONLY the tx handle. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Optional Postgres schema (DATABASE_SCHEMA). Lets PayFlow share a database with other apps:
 * every connection sets search_path to it, and migrations create it first. Unset → "public".
 */
export function dbSchema(): string | null {
  const s = process.env.DATABASE_SCHEMA?.trim();
  if (!s) return null;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error("DATABASE_SCHEMA must be a lowercase identifier");
  return s;
}

/** Schema SQL with the CREATE SCHEMA prelude when DATABASE_SCHEMA is set. */
export async function postgresSchemaSql(): Promise<string> {
  const schema = dbSchema();
  const text = await schemaSql();
  return schema ? `CREATE SCHEMA IF NOT EXISTS ${schema};\nSET search_path TO ${schema};\n${text}` : text;
}

// ---------- postgres.js ----------
type PgSql = postgres.Sql<Record<string, never>>;
type PgTx = postgres.TransactionSql<Record<string, never>>;

function wrapPostgres(sql: PgSql | PgTx, isTx: boolean, root: PgSql, ready: () => Promise<void>): Db {
  const db: Db = {
    kind: "postgres",
    async query<T>(text: string, params: unknown[] = []) {
      if (!isTx) await ready();
      const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return [...rows] as unknown as T[];
    },
    async exec(text: string) {
      await sql.unsafe(text);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (isTx) return fn(db);
      await ready();
      return (await root.begin((tx) => fn(wrapPostgres(tx, true, root, ready)))) as T;
    },
    async close() {
      if (!isTx) await root.end({ timeout: 5 });
    },
  };
  return db;
}

export function createPostgresDb(url: string, opts: { autoMigrate?: boolean } = {}): Db {
  const schema = dbSchema();
  const sql = postgres(url, {
    ...(schema ? { connection: { search_path: schema } } : {}),
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    prepare: false, // transaction-mode poolers (Supabase/Neon) don't support named statements
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  }) as unknown as PgSql;
  let migrated: Promise<void> | null = null;
  const ready = () => {
    if (!opts.autoMigrate) return Promise.resolve();
    if (!migrated) {
      migrated = (async () => {
        const text = await postgresSchemaSql().catch(() => null);
        // In serverless bundles schema.sql may not be traced; run `npm run db:migrate` there.
        if (text) await sql.unsafe(text);
      })().catch((e) => {
        migrated = null;
        throw e;
      });
    }
    return migrated;
  };
  return wrapPostgres(sql, false, sql, ready);
}

// ---------- PGlite ----------
interface PgTxLike {
  query<R>(t: string, p?: unknown[]): Promise<{ rows: R[] }>;
  exec(t: string): Promise<unknown>;
}
interface PgliteLike extends PgTxLike {
  transaction<T>(fn: (tx: PgTxLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const PG_INT8 = 20;
const PG_NUMERIC = 1700;

/** `dataDir` may be "memory://" (tests). PGlite is loaded lazily and hidden from the bundler. */
export function createPgliteDb(dataDir: string, opts: { autoMigrate?: boolean } = {}): Db {
  let instance: Promise<PgliteLike> | null = null;
  const open = () => {
    if (!instance) {
      instance = (async () => {
        const specifier = "@electric-sql/pglite";
        const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier)) as {
          PGlite: new (dir?: string, o?: unknown) => PgliteLike;
        };
        if (!dataDir.startsWith("memory://")) {
          const fs = await import("node:fs");
          fs.mkdirSync(dataDir, { recursive: true });
        }
        const pg = new mod.PGlite(dataDir, { parsers: { [PG_INT8]: (x: string) => x, [PG_NUMERIC]: (x: string) => x } });
        if (opts.autoMigrate) await pg.exec(await schemaSql());
        return pg;
      })();
      instance.catch(() => {
        instance = null;
      });
    }
    return instance;
  };
  const wrapTx = (tx: PgTxLike): Db => {
    const d: Db = {
      kind: "pglite",
      async query<T>(text: string, params: unknown[] = []) {
        return (await tx.query<T>(text, params)).rows;
      },
      async exec(text: string) {
        await tx.exec(text);
      },
      async transaction<T>(fn: (t: Db) => Promise<T>) {
        return fn(d);
      },
      async close() {},
    };
    return d;
  };
  return {
    kind: "pglite",
    async query<T>(text: string, params: unknown[] = []) {
      return (await (await open()).query<T>(text, params)).rows;
    },
    async exec(text: string) {
      await (await open()).exec(text);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return (await open()).transaction((tx) => fn(wrapTx(tx)));
    },
    async close() {
      if (instance) await (await instance).close();
      instance = null;
    },
  };
}

// ---------- process singleton ----------
const g = globalThis as unknown as { __payflowDb?: Db };

export function dbKind(): "postgres" | "pglite" {
  return process.env.DATABASE_URL ? "postgres" : "pglite";
}

export function getDb(): Db {
  if (!g.__payflowDb) {
    g.__payflowDb = process.env.DATABASE_URL
      ? createPostgresDb(process.env.DATABASE_URL, { autoMigrate: true })
      : createPgliteDb(process.env.PGLITE_DIR || ".data/pglite", { autoMigrate: true });
  }
  return g.__payflowDb;
}

/** Test hook: replace the process DB. */
export function setDb(db: Db | undefined): void {
  g.__payflowDb = db;
}
