/**
 * db.ts — optional Postgres pool (Supabase / Railway / local).
 * When DATABASE_URL is unset the app stays on the file walkthrough store.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let migration: Promise<void> | null = null;

export function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url || undefined;
}

export function getPool(): pg.Pool | null {
  const url = databaseUrl();
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: url.includes("supabase") || url.includes("sslmode=require")
        ? { rejectUnauthorized: false }
        : undefined,
      max: 5,
    });
    // An idle client dropped by the pooler must not crash the process.
    pool.on("error", (err) => console.warn("[db] idle client error:", err.message));
  }
  return pool;
}

/** Run idempotent schema migration once per process. */
export function ensureSchema(): Promise<void> {
  const p = getPool();
  if (!p) return Promise.resolve();
  migration ??= (async () => {
    const sqlPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../sql/001_init.sql"
    );
    await p.query(await readFile(sqlPath, "utf-8"));
    console.log("[db] schema ready");
  })().catch((err) => {
    migration = null;
    throw err;
  });
  return migration;
}

/**
 * Best-effort ping so Free Supabase projects stay awake (they pause after 7 idle days).
 * Every 12 hours by default: with a 3-day interval a single failed ping (only logged) left a
 * gap of up to 6 days, one bad day from a paused database.
 */
export function startKeepAlive(): void {
  if (process.env.SUPABASE_KEEPALIVE === "0") return;
  const p = getPool();
  if (!p) return;
  const everyMs = Number(process.env.SUPABASE_KEEPALIVE_MS ?? 12 * 60 * 60 * 1000);
  setInterval(() => {
    void p.query("SELECT 1").catch((err) => {
      console.warn("[db] keepalive failed:", err instanceof Error ? err.message : err);
    });
  }, everyMs).unref();
}
