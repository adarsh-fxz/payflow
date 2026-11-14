import { createPgliteDb, type Db } from "@/lib/server/db";

export async function freshDb(): Promise<Db> {
  const db = createPgliteDb("memory://", { autoMigrate: true });
  await db.query("SELECT 1");
  return db;
}
