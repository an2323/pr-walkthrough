/**
 * migrate-to-supabase.ts — copy the local analysis history into Supabase.
 *
 *   pnpm --filter @pr-walkthrough/server migrate:supabase [--dry-run]
 *
 * Needs DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.
 * Copies, for Excalidraw PRs only (Outline's licence is unverified):
 *   data/walkthroughs/{owner}/{repo}/{n}.json  → walkthroughs table
 *   data/events/{owner}/{repo}/{n}.ndjson      → events/… (replays)
 *   data/shots/{owner}/{repo}/{n}/*.png        → shots/…
 *   data/audio/{owner}/{repo}/{n}/*.mp3        → audio/…
 * Idempotent: rows are upserted and objects overwritten, so it can be re-run.
 */
import "../src/env.js";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Walkthrough } from "@pr-walkthrough/shared";
import { databaseUrl, getPool } from "../src/db.js";
import { blobsEnabled, uploadBlob, uploadDir } from "../src/blobs.js";
import { loadWalkthrough, saveWalkthrough } from "../src/storage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ALLOWED = [{ owner: "excalidraw", repo: "excalidraw" }];
const dryRun = process.argv.includes("--dry-run");

if (!dryRun && (!databaseUrl() || !blobsEnabled())) {
  throw new Error("Set DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (or pass --dry-run)");
}

async function numbersIn(dir: string, pattern: RegExp): Promise<number[]> {
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (const name of await readdir(dir)) {
    const m = pattern.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

let totals = { walkthroughs: 0, recordings: 0, shots: 0, audio: 0 };

for (const { owner, repo } of ALLOWED) {
  const wtDir = path.join(ROOT, "data/walkthroughs", owner, repo);
  for (const number of await numbersIn(wtDir, /^(\d+)\.json$/)) {
    const spec = `${owner}/${repo}#${number}`;
    const wt = JSON.parse(await readFile(path.join(wtDir, `${number}.json`), "utf-8")) as Walkthrough;
    if (wt.pr.repo !== `${owner}/${repo}` || wt.pr.number !== number) {
      console.warn(`${spec}: file says ${wt.pr.repo}#${wt.pr.number} — skipped`);
      continue;
    }

    const events = path.join(ROOT, "data/events", owner, repo, `${number}.ndjson`);
    const shotsDir = path.join(ROOT, "data/shots", owner, repo, String(number));
    const audioDir = path.join(ROOT, "data/audio", owner, repo, String(number));
    const audioFiles = existsSync(audioDir) ? (await readdir(audioDir)).filter((f) => f.endsWith(".mp3")) : [];

    if (dryRun) {
      console.log(
        `${spec}: walkthrough, recording ${existsSync(events) ? "yes" : "no"}, ` +
          `shots dir ${existsSync(shotsDir) ? "yes" : "no"}, ${audioFiles.length} mp3`
      );
      continue;
    }

    await saveWalkthrough(wt);
    totals.walkthroughs++;

    if (existsSync(events)) {
      await uploadBlob(`events/${owner}/${repo}/${number}.ndjson`, await readFile(events, "utf-8"));
      totals.recordings++;
    }

    const shots = await uploadDir(shotsDir, `shots/${owner}/${repo}/${number}`);
    totals.shots += shots;

    for (const file of audioFiles) {
      await uploadBlob(`audio/${owner}/${repo}/${number}/${file}`, await readFile(path.join(audioDir, file)));
    }
    totals.audio += audioFiles.length;

    const back = await loadWalkthrough(owner, repo, number);
    const ok = back !== null && back.steps.length === wt.steps.length;
    console.log(
      `${spec}: walkthrough ${ok ? "✓" : "✗ (read-back mismatch)"}, ` +
        `recording ${existsSync(events) ? "✓" : "—"}, ${shots} shot(s), ${audioFiles.length} mp3`
    );
  }
}

if (!dryRun) {
  console.log(
    `done: ${totals.walkthroughs} walkthrough(s), ${totals.recordings} recording(s), ` +
      `${totals.shots} shot(s), ${totals.audio} audio file(s)`
  );
}
await getPool()?.end();
