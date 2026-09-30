/**
 * storage.ts — load/save walkthroughs.
 *
 * - With DATABASE_URL: Postgres is the source of truth for live results.
 *   File store under data/walkthroughs/ is only a read fallback (golden fixtures).
 * - Without DATABASE_URL: file store only (local demo / cached analyzer).
 *
 * Production never writes new analyses into the git tree.
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Walkthrough } from "@pr-walkthrough/shared";
import { ensureSchema, getPool } from "./db.js";
import { inRehearsal } from "./analyzer/bob-command.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function walkthroughPath(owner: string, repo: string, number: number): string {
  return path.join(ROOT, "data/walkthroughs", owner, repo, `${number}.json`);
}

async function loadFromFile(
  owner: string,
  repo: string,
  number: number
): Promise<Walkthrough | null> {
  const filePath = walkthroughPath(owner, repo, number);
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as Walkthrough;
}

async function saveToFile(wt: Walkthrough): Promise<string> {
  const [owner, repo] = wt.pr.repo.split("/");
  const filePath = walkthroughPath(owner, repo, wt.pr.number);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(wt, null, 2), "utf-8");
  return filePath;
}

async function loadFromDb(
  owner: string,
  repo: string,
  number: number
): Promise<Walkthrough | null> {
  const pool = getPool();
  if (!pool) return null;
  await ensureSchema();
  const { rows } = await pool.query<{ payload: Walkthrough }>(
    `SELECT payload FROM walkthroughs WHERE owner = $1 AND repo = $2 AND number = $3`,
    [owner, repo, number]
  );
  return rows[0]?.payload ?? null;
}

async function saveToDb(wt: Walkthrough): Promise<string> {
  const pool = getPool();
  if (!pool) throw new Error("DATABASE_URL is not set");
  await ensureSchema();
  const [owner, repo] = wt.pr.repo.split("/");
  const headSha = wt.pr.headSha ?? null;
  await pool.query(
    `INSERT INTO walkthroughs (owner, repo, number, head_sha, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (owner, repo, number) DO UPDATE SET
       head_sha = EXCLUDED.head_sha,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [owner, repo, wt.pr.number, headSha, JSON.stringify(wt)]
  );
  return `db:walkthroughs/${owner}/${repo}/${wt.pr.number}`;
}

/** Where a rehearsal's result goes — local only, never over the real walkthrough. */
function rehearsalPath(owner: string, repo: string, number: number): string {
  return path.join(ROOT, "data/rehearsals", owner, repo, `${number}.json`);
}

/** The last rehearsal's result for this PR, if any (GET /api/walkthroughs/...?rehearsal=1). */
export async function loadRehearsal(owner: string, repo: string, number: number): Promise<Walkthrough | null> {
  const p = rehearsalPath(owner, repo, number);
  return existsSync(p) ? (JSON.parse(await readFile(p, "utf-8")) as Walkthrough) : null;
}

/** Persist a completed walkthrough. Returns a locator string (db:… or file path). */
export async function saveWalkthrough(wt: Walkthrough): Promise<string> {
  if (inRehearsal()) {
    const [owner, repo] = wt.pr.repo.split("/");
    const p = rehearsalPath(owner, repo, wt.pr.number);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(wt, null, 2), "utf-8");
    return p;
  }
  if (getPool()) return saveToDb(wt);
  return saveToFile(wt);
}

/** Load a walkthrough. DB first (when configured), then local fixtures. */
export async function loadWalkthrough(
  owner: string,
  repo: string,
  number: number
): Promise<Walkthrough | null> {
  if (getPool()) {
    const fromDb = await loadFromDb(owner, repo, number);
    if (fromDb) return fromDb;
  }
  return loadFromFile(owner, repo, number);
}

export interface WalkthroughSummary {
  owner: string;
  repo: string;
  number: number;
  title?: string;
  problem?: string;
  /** Before-frame file name (under data/shots/owner/repo/number/), for a thumbnail. */
  thumb?: string;
  costUsd?: number;
  updatedAt: string;
}

/**
 * The most recently finished walkthroughs, newest first — so a run started from the site can be found
 * again from the landing page (it used to show only two hard-coded examples). Database only.
 */
export async function listRecentWalkthroughs(limit = 12): Promise<WalkthroughSummary[]> {
  const pool = getPool();
  if (!pool) return listRecentFromFiles(limit);
  await ensureSchema();
  const { rows } = await pool.query<{
    owner: string; repo: string; number: number; updated_at: Date;
    title: string | null; problem: string | null; thumb: string | null; cost: string | null;
  }>(
    `SELECT owner, repo, number, updated_at,
            payload->'plain'->>'title' AS title,
            payload->'plain'->>'problem' AS problem,
            payload->'shots'->'before'->>'src' AS thumb,
            payload->'meta'->'run'->>'costUsd' AS cost
       FROM walkthroughs ORDER BY updated_at DESC LIMIT $1`,
    [Math.max(1, Math.min(50, limit))]
  );
  return rows.map((r) => ({
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    updatedAt: r.updated_at.toISOString(),
    ...(r.title ? { title: r.title } : {}),
    ...(r.problem ? { problem: r.problem } : {}),
    ...(r.thumb ? { thumb: r.thumb } : {}),
    ...(r.cost ? { costUsd: Number(r.cost) } : {}),
  }));
}

/**
 * Without a database (local dev, the cached demo) the finished walkthroughs are the files under
 * data/walkthroughs/{owner}/{repo}/{number}.json — newest first by file time, so the landing is not empty.
 */
export async function listRecentFromFiles(
  limit = 12,
  dir: string = path.join(ROOT, "data/walkthroughs")
): Promise<WalkthroughSummary[]> {
  const found: { owner: string; repo: string; number: number; file: string; mtime: Date }[] = [];
  const dirs = async (d: string): Promise<string[]> =>
    existsSync(d) ? (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  for (const owner of await dirs(dir)) {
    for (const repo of await dirs(path.join(dir, owner))) {
      const repoDir = path.join(dir, owner, repo);
      for (const name of await readdir(repoDir)) {
        const m = /^(\d+)\.json$/.exec(name);
        if (!m) continue;
        const file = path.join(repoDir, name);
        found.push({ owner, repo, number: Number(m[1]), file, mtime: (await stat(file)).mtime });
      }
    }
  }
  found.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const out: WalkthroughSummary[] = [];
  for (const f of found.slice(0, Math.max(1, Math.min(50, limit)))) {
    try {
      const wt = JSON.parse(await readFile(f.file, "utf-8")) as Walkthrough;
      const cost = wt.meta?.run?.costUsd;
      out.push({
        owner: f.owner,
        repo: f.repo,
        number: f.number,
        updatedAt: f.mtime.toISOString(),
        ...(wt.plain?.title ? { title: wt.plain.title } : {}),
        ...(wt.plain?.problem ? { problem: wt.plain.problem } : {}),
        ...(wt.shots?.before?.src ? { thumb: wt.shots.before.src } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      });
    } catch {
      // an unreadable file is simply not listed
    }
  }
  return out;
}

/** Job rows created since `since`, or null without a database. */
export async function countJobRowsSince(since: Date): Promise<number | null> {
  const pool = getPool();
  if (!pool) return null;
  await ensureSchema();
  const { rows } = await pool.query<{ n: string }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE created_at >= $1",
    [since]
  );
  return Number(rows[0]?.n ?? 0);
}

/** Record job lifecycle in Postgres when available (SSE backlog stays in-memory). */
export async function upsertJobRow(row: {
  id: string;
  owner: string;
  repo: string;
  number: number;
  status: string;
  error?: string | null;
  finished?: boolean;
}): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await ensureSchema();
  await pool.query(
    `INSERT INTO jobs (id, owner, repo, number, status, error, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       finished_at = COALESCE(EXCLUDED.finished_at, jobs.finished_at)`,
    [
      row.id,
      row.owner,
      row.repo,
      row.number,
      row.status,
      row.error ?? null,
      row.finished ? new Date() : null,
    ]
  );
}

/**
 * A job row still `queued`/`running` when the process starts belongs to a process that no longer
 * exists (restart, deploy, crash) — nothing in memory is running it. Mark them failed so the
 * ledger and any reader see the truth. Returns how many rows were fixed (0 without a database).
 */
export async function failStaleJobRows(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  await ensureSchema();
  const res = await pool.query(
    `UPDATE jobs SET status = 'failed', error = 'server restarted', finished_at = NOW()
     WHERE status IN ('queued', 'running')`
  );
  return res.rowCount ?? 0;
}
