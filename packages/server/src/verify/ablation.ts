/**
 * verify/ablation.ts — ST12-D: which of a PR's hunks the fix actually needs,
 * measured instead of read. For each "unit" (a logic hunk — mechanical ones
 * from `skippedHunks` are always excluded), two runs against a fresh BASE
 * checkout patched with a chosen subset of hunks (diff/split-hunks.ts):
 *  - "alone": only this unit applied — does it fix the bug by itself?
 *  - "all-but-one": every OTHER unit applied, this one held back — does the
 *    bug come back without it?
 * Each run starts the app (verify/app-servers.ts — scrubbed env, its own
 * process group) and runs the verifier's own `repro.cjs <url>` (ST12-C),
 * reading its `{bugPresent}` line. The throwaway worktree is removed right
 * after, whether the run succeeded or not — these are disposable, unlike the
 * analyzer's cached per-SHA worktrees.
 *
 * v1 limitation: unit = one hunk. Two genuinely separate changes that a diff
 * happens to emit as one hunk (adjacent lines, no unchanged line of context
 * between them) can't be told apart — reported per-step as "not-separable"
 * (see `verdictForStep`), not silently guessed at.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AblationRun, Ablation, Hunk, SkippedHunk } from "@pr-walkthrough/shared";

import { splitDiffHunks, buildHunkPatch, type DiffHunk } from "../diff/split-hunks.js";
import { ensureInstalled, startApp, type AppServer } from "./app-servers.js";
import type { AppRecipe } from "./recipes.js";

const execFileAsync = promisify(execFile);

const MAX_UNITS = 5; // caps total runs at 2*MAX_UNITS = 10, per the plan

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Run `repro.cjs <url>`, parsing its last stdout line as `{"bugPresent": boolean, ...}`. */
async function runRepro(reproPath: string, url: string, cwd: string): Promise<{ bugPresent: boolean } | { error: string }> {
  try {
    const { stdout } = await execFileAsync("node", [reproPath, url], { cwd, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(lastLine) as { bugPresent: unknown };
    if (typeof parsed.bugPresent !== "boolean") return { error: "repro.cjs did not print {bugPresent: boolean}" };
    return { bugPresent: parsed.bugPresent };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

/** One throwaway BASE checkout, patched with `apply`, app started, repro run, then torn down. */
async function oneRun(opts: {
  mainPath: string;
  baseSha: string;
  apply: DiffHunk[];
  recipe: AppRecipe;
  reproPath: string;
}): Promise<{ verdict: AblationRun["verdict"]; detail?: string }> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "pr-walkthrough-ablation-"));
  let server: AppServer | undefined;
  try {
    await git(opts.mainPath, ["worktree", "add", "--detach", "--quiet", scratch, opts.baseSha]);
    for (const hunk of opts.apply) {
      const patchPath = path.join(scratch, ".ablation-patch.diff");
      await writeFile(patchPath, buildHunkPatch(hunk));
      try {
        await execFileAsync("git", ["apply", ".ablation-patch.diff"], { cwd: scratch });
      } catch (err) {
        return { verdict: "broken", detail: `git apply ${hunk.id} failed: ${err instanceof Error ? err.message.slice(0, 200) : err}` };
      }
    }

    try {
      await ensureInstalled(opts.recipe, scratch);
    } catch (err) {
      return { verdict: "broken", detail: `install failed: ${err instanceof Error ? err.message.slice(0, 200) : err}` };
    }
    try {
      server = await startApp(opts.recipe, scratch);
    } catch (err) {
      return { verdict: "broken", detail: `app didn't start: ${err instanceof Error ? err.message.slice(0, 200) : err}` };
    }

    const result = await runRepro(opts.reproPath, server.url, scratch);
    if ("error" in result) return { verdict: "broken", detail: result.error };
    return { verdict: result.bugPresent ? "bug" : "fixed" };
  } finally {
    if (server) await server.stop();
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await git(opts.mainPath, ["worktree", "remove", "--force", scratch]).catch(() => {
      // best effort — a leftover worktree entry is harmless, `git worktree prune` cleans it later
    });
  }
}

export interface RunAblationOptions {
  mainPath: string; // <cacheDir>/<owner>__<repo> — the shared clone
  baseSha: string;
  diff: string;
  hunks: Hunk[]; // walkthrough.hunks
  skippedHunks?: SkippedHunk[];
  recipe: AppRecipe;
  reproPath: string;
  onProgress?: (msg: string) => void;
}

/** Logic units in the order they'll be tested — mechanical/skipped hunks never included. */
export function logicUnits(hunks: Hunk[], skippedHunks: SkippedHunk[] = []): string[] {
  const skipped = new Set(skippedHunks.map((s) => s.hunkId));
  return hunks.map((h) => h.id).filter((id) => !skipped.has(id));
}

export async function runAblation(opts: RunAblationOptions): Promise<Ablation> {
  const allHunks = splitDiffHunks(opts.diff);
  const byId = new Map(allHunks.map((h) => [h.id, h]));
  const units = logicUnits(opts.hunks, opts.skippedHunks).filter((id) => byId.has(id)).slice(0, MAX_UNITS);

  const runs: AblationRun[] = [];
  for (const unitId of units) {
    opts.onProgress?.(`Testing "${unitId}" alone`);
    const alone = await oneRun({ mainPath: opts.mainPath, baseSha: opts.baseSha, apply: [byId.get(unitId)!], recipe: opts.recipe, reproPath: opts.reproPath });
    runs.push({ unitIds: [unitId], mode: "alone", verdict: alone.verdict, detail: alone.detail });
  }
  for (const unitId of units) {
    const rest = units.filter((id) => id !== unitId);
    opts.onProgress?.(`Testing everything except "${unitId}"`);
    const allBut = await oneRun({ mainPath: opts.mainPath, baseSha: opts.baseSha, apply: rest.map((id) => byId.get(id)!), recipe: opts.recipe, reproPath: opts.reproPath });
    runs.push({ unitIds: rest, mode: "all-but-one", verdict: allBut.verdict, detail: allBut.detail });
  }

  return { units, runs };
}

export type StepVerdict = "needed" | "fixes-alone" | "no-effect" | "not-separable";

/**
 * A step's verdict from the ablation table — "not-separable" when the step's
 * hunks don't map to exactly one tested unit (v1's hunk-granularity limit),
 * or when either of its two runs is missing/broken and gives no signal.
 */
export function verdictForStep(ablation: Ablation, stepHunkIds: string[]): StepVerdict | undefined {
  const relevant = stepHunkIds.filter((id) => ablation.units.includes(id));
  if (relevant.length !== 1 || relevant.length !== stepHunkIds.length) return "not-separable";
  const unitId = relevant[0];

  const alone = ablation.runs.find((r: AblationRun) => r.mode === "alone" && r.unitIds.length === 1 && r.unitIds[0] === unitId);
  const allBut = ablation.runs.find(
    (r: AblationRun) => r.mode === "all-but-one" && r.unitIds.length === ablation.units.length - 1 && !r.unitIds.includes(unitId)
  );

  const fixesAlone = alone?.verdict === "fixed";
  const needed = allBut?.verdict === "bug";
  if (needed) return "needed"; // most informative label when both true
  if (fixesAlone) return "fixes-alone";
  if (alone?.verdict === "bug" && allBut?.verdict === "fixed") return "no-effect";
  return undefined; // both runs "broken", or the pair is otherwise inconclusive — say nothing rather than guess
}
