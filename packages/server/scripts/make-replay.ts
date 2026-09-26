/**
 * make-replay.ts — convert a raw Bob Shell run recording
 * (data/runs/<stamp>/events.ndjson + summary.json, written by bob-spike.ts)
 * into the small, committed replay file the web app streams for $0 demo
 * playback: data/events/<owner>/<repo>/<number>.ndjson (ST6c).
 *
 * Reuses createProgressNormalizer — the SAME code path a live run uses to
 * turn raw bob events into the UI-facing ProgressEvent stream — so a replay
 * always renders identically to what the live progress screen would have
 * shown during the real run.
 *
 * The pipeline stages that surround Bob (workspace prep, validation,
 * saving) aren't part of the raw recording (that only captures the bob
 * subprocess's own stdout), so this script synthesizes them from the
 * cached walkthrough's own numbers (hunks/skippedHunks, meta.run) — the
 * same values the real pipeline would have reported.
 *
 * Usage:
 *   pnpm --filter @pr-walkthrough/server make-replay <owner> <repo> <number> <runDir...>
 *
 * Multiple run dirs are concatenated in order (e.g. a `full` run followed by
 * the `repair` run that made it valid), with `t` continuing to increase
 * across the boundary.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProgressEvent } from "@pr-walkthrough/shared";
import { createProgressNormalizer } from "../src/analyzer/progress-normalizer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface RunSummary {
  mode?: string;
  durationSec?: number;
  taskId?: string;
  sessionCost?: number;
  toolCalls?: number;
  subagents?: number;
  valid?: boolean;
}

interface CachedWalkthroughShape {
  hunks?: unknown[];
  skippedHunks?: unknown[];
  meta?: { run?: { costUsd?: number; maxCostUsd?: number; toolCalls?: number; subagents?: number } };
}

async function loadRun(runDir: string): Promise<{ events: unknown[]; summary: RunSummary }> {
  const raw = await readFile(path.join(runDir, "events.ndjson"), "utf-8");
  const events = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let summary: RunSummary = {};
  try {
    summary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf-8"));
  } catch {
    // optional — fall back to defaults below
  }
  return { events, summary };
}

/**
 * Real timestamps are preferred (every raw event carries its own ISO
 * `timestamp`) so the replay keeps the run's actual pacing — bursts of tool
 * calls, long quiet stretches while Bob "thinks". Falls back to spreading
 * events evenly over the recorded duration if a timestamp is ever missing.
 */
function eventTimeMs(e: unknown, index: number, total: number, startMs: number, durationMs: number): number {
  const ts = (e as Record<string, unknown> | undefined)?.["timestamp"];
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return startMs + (total <= 1 ? 0 : (index / (total - 1)) * durationMs);
}

/**
 * Normalize one run dir's raw events into `out`, continuing the global `t`
 * timeline from `tOffset`. Returns the new offset (the last emitted `t`) for
 * the next run dir, if any.
 */
async function convertRun(runDir: string, out: ProgressEvent[], tOffset: number): Promise<number> {
  const { events, summary } = await loadRun(runDir);
  if (events.length === 0) return tOffset;

  const firstTs = Date.parse((events[0] as Record<string, unknown> | undefined)?.["timestamp"] as string);
  const startMs = Number.isNaN(firstTs) ? 0 : firstTs;
  const durationMs = (summary.durationSec ?? 0) * 1000 || 60_000;

  // Anchor the normalizer so `handle(e, eventTimeMs)` yields
  // t = (eventTimeMs - startMs) + tOffset — i.e. this run's events continue
  // right after the previous run's last `t`.
  const normalizer = createProgressNormalizer(startMs - tOffset, (e) => out.push(e));
  events.forEach((e, i) => {
    normalizer.handle(e, eventTimeMs(e, i, events.length, startMs, durationMs));
  });

  const last = out[out.length - 1];
  return last ? last.t : tOffset;
}

async function main(): Promise<void> {
  const [owner, repo, number, ...runDirArgs] = process.argv.slice(2);
  if (!owner || !repo || !number || runDirArgs.length === 0) {
    console.error("Usage: make-replay <owner> <repo> <number> <runDir...>");
    process.exit(1);
  }

  const out: ProgressEvent[] = [];

  // Stage events the raw recording doesn't carry (it only captures the bob
  // subprocess itself) — synthesized from the cached walkthrough's own
  // numbers so the replay's stage list matches what really happened.
  const cachedPath = path.join(ROOT, "data/walkthroughs", owner, repo, `${number}.json`);
  let cached: CachedWalkthroughShape = {};
  try {
    cached = JSON.parse(await readFile(cachedPath, "utf-8"));
  } catch {
    console.warn(`(no cached walkthrough at ${cachedPath} — stage labels will be generic)`);
  }
  const hunkCount = cached.hunks?.length;
  const skippedCount = cached.skippedHunks?.length ?? 0;

  out.push({ kind: "stage", t: 0, stage: "clone", label: "Preparing the git workspace" });
  out.push({
    kind: "stage",
    t: 50,
    stage: "hunks",
    label:
      hunkCount === undefined
        ? "Reading the diff"
        : skippedCount > 0
          ? `${hunkCount} hunks (${skippedCount} auto-skipped)`
          : `${hunkCount} hunks`,
  });
  out.push({ kind: "stage", t: 100, stage: "analyzing", label: "Bob is analyzing the PR" });

  let tOffset = 100;
  for (const [i, dirArg] of runDirArgs.entries()) {
    const runDir = path.isAbsolute(dirArg) ? dirArg : path.join(ROOT, dirArg);
    if (i > 0) {
      // A second run dir is a repair pass, by convention (see the script header).
      out.push({ kind: "stage", t: tOffset + 50, stage: "validating", label: "Validating the walkthrough" });
      out.push({ kind: "stage", t: tOffset + 100, stage: "repairing", label: "Fixing validation issues" });
      tOffset += 100;
    }
    tOffset = await convertRun(runDir, out, tOffset);
  }

  out.push({ kind: "stage", t: tOffset + 50, stage: "validating", label: "Validating the walkthrough" });
  out.push({ kind: "stage", t: tOffset + 100, stage: "saving", label: "Saving the walkthrough" });

  const run = cached.meta?.run;
  const finalT = tOffset + 150;
  out.push({
    kind: "done",
    t: finalT,
    // Rewritten by the server at replay time to its own host — this is just
    // a self-describing placeholder for anyone reading the file directly.
    walkthroughUrl: `/api/walkthroughs/${owner}/${repo}/${number}`,
    durationMs: finalT,
    costUsd: run?.costUsd,
    toolCalls: run?.toolCalls,
    subagents: run?.subagents,
  });

  const outPath = path.join(ROOT, "data/events", owner, repo, `${number}.ndjson`);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, out.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`Wrote ${out.length} events to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
