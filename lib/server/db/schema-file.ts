import "../guard";

let cached: string | null = null;

/** Reads the frozen lib/server/db/schema.sql (idempotent: CREATE … IF NOT EXISTS). */
export async function schemaSql(): Promise<string> {
  if (cached) return cached;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const candidates = [path.join(process.cwd(), "lib/server/db/schema.sql")];
  if (typeof __dirname !== "undefined") candidates.push(path.join(__dirname, "schema.sql"));
  let lastErr: unknown;
  for (const file of candidates) {
    try {
      cached = await fs.readFile(file, "utf8");
      return cached;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`schema.sql not found (${candidates.join(", ")}): ${String(lastErr)}`);
}
