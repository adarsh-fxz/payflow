import { afterEach, describe, expect, it, vi } from "vitest";
import { dbSchema, postgresSchemaSql } from "@/lib/server/db";

afterEach(() => vi.unstubAllEnvs());

describe("DATABASE_SCHEMA", () => {
  it("defaults to the public schema", async () => {
    vi.stubEnv("DATABASE_SCHEMA", "");
    expect(dbSchema()).toBeNull();
    expect(await postgresSchemaSql()).not.toMatch(/CREATE SCHEMA/);
  });

  it("creates and selects the schema before the tables", async () => {
    vi.stubEnv("DATABASE_SCHEMA", "payflow");
    const sql = await postgresSchemaSql();
    expect(sql.startsWith("CREATE SCHEMA IF NOT EXISTS payflow;\nSET search_path TO payflow;\n")).toBe(true);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payroll_runs/i);
  });

  it("rejects names that are not plain identifiers", () => {
    vi.stubEnv("DATABASE_SCHEMA", "payflow; drop table x");
    expect(() => dbSchema()).toThrow(/lowercase identifier/);
  });
});
