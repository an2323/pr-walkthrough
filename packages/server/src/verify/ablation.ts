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
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { AblationRun, AblationScenario, Ablation, Hunk, SkippedHunk } from "@pr-walkthrough/shared";

import { splitDiffHunks, buildHunkPatch, type DiffHunk } from "../diff/split-hunks.js";
import { ensureInstalled, scrubbedEnv, startApp, type AppServer } from "./app-servers.js";
import type { AppRecipe } from "./recipes.js";

const execFileAsync = promisify(execFile);

const MAX_UNITS = 5; // caps total runs at 2*MAX_UNITS = 10, per the plan

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export interface ReproResult {
  bugPresent: boolean;
  measure?: unknown;
  highlights?: unknown[];
}

/**
 * Run `repro.cjs <url> [pngPath]` (the ST12-C contract — see bob-verifier.ts,
 * which authors and first confirms this script) and parse its last stdout
 * line. Used both to confirm the script against BASE/HEAD and, by the
 * ablation runner, to test it against many disposable partial-patch builds.
 *
 * The script is Bob-written code, so it runs with a scrubbed environment (no DB
 * password, no service key) and its failure message keeps the tail of stderr —
 * "Command failed: node /long/path…" alone hides the real cause.
 */
export async function runRepro(
  reproPath: string,
  url: string,
  cwd: string,
  pngPath?: string,
  timeoutMs = 120_000
): Promise<ReproResult | { error: string }> {
  try {
    const args = pngPath ? [reproPath, url, pngPath] : [reproPath, url];
    const { stdout } = await execFileAsync("node", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: scrubbedEnv(),
    });
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(lastLine) as { bugPresent: unknown; measure?: unknown; highlights?: unknown };
    if (typeof parsed.bugPresent !== "boolean") return { error: "repro.cjs did not print {bugPresent: boolean}" };
    return { bugPresent: parsed.bugPresent, measure: parsed.measure, highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [] };
  } catch (err) {
    const e = err as { message?: string; stderr?: string; killed?: boolean };
    const stderrTail = (e.stderr ?? "").trim().split("\n").slice(-4).join(" | ");
    const head = e.killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e.message ?? String(err)).split("\n")[0];
    return { error: `${head}${stderrTail ? ` — ${stderrTail}` : ""}`.slice(0, 500) };
  }
}

/**
 * One throwaway BASE checkout, patched with `apply`, app started, repro run, then torn down.
 * The scratch lives under `<clone>/wt/` — next to the installed BASE/HEAD worktrees — so the
 * install can copy `node_modules` from one of them instead of running a full `yarn install`
 * on every one of up to ten runs.
 */
type Verdict = AblationRun["verdict"];
type RunOutcome = { verdict: Verdict; detail?: string; infra?: boolean; results?: NonNullable<AblationRun["results"]> };

/** Summary verdict over scenarios, for readers of the old single-verdict format. */
export function summaryVerdict(results: { verdict: Verdict }[]): Verdict {
  if (results.some((r) => r.verdict === "bug")) return "bug";
  if (results.some((r) => r.verdict === "fixed")) return "fixed";
  return "broken";
}

async function oneRun(opts: {
  mainPath: string;
  baseSha: string;
  apply: DiffHunk[];
  recipe: AppRecipe;
  repros: { id: string; path: string }[];
}): Promise<RunOutcome> {
  const wtRoot = path.join(opts.mainPath, "wt");
  await mkdir(wtRoot, { recursive: true });
  const scratch = path.join(wtRoot, `abl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  let server: AppServer | undefined;
  let created = false;
  try {
    await git(opts.mainPath, ["worktree", "add", "--detach", "--quiet", scratch, opts.baseSha]);
    created = true;
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
      await ensureInstalled(opts.recipe, scratch, { donor: path.join(wtRoot, opts.baseSha) });
    } catch (err) {
      return { verdict: "broken", infra: true, detail: `install failed: ${err instanceof Error ? err.message.slice(0, 200) : err}` };
    }
    try {
      server = await startApp(opts.recipe, scratch);
    } catch (err) {
      return { verdict: "broken", infra: true, detail: `app didn't start: ${err instanceof Error ? err.message.slice(0, 200) : err}` };
    }

    // One build, every scenario: each scenario's own script against the same running app.
    const results: NonNullable<AblationRun["results"]> = [];
    for (const repro of opts.repros) {
      const r = await runRepro(repro.path, server.url, path.dirname(repro.path));
      results.push("error" in r ? { scenarioId: repro.id, verdict: "broken", detail: r.error } : { scenarioId: repro.id, verdict: r.bugPresent ? "bug" : "fixed" });
    }
    if (results.length === 1) return { verdict: results[0].verdict, ...(results[0].detail ? { detail: results[0].detail } : {}) };
    return { verdict: summaryVerdict(results), results };
  } finally {
    if (server) await server.stop();
    // Unregister first (git refuses once the directory is gone), then make sure it's really gone.
    if (created) await git(opts.mainPath, ["worktree", "remove", "--force", scratch]).catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await git(opts.mainPath, ["worktree", "prune"]).catch(() => {});
  }
}

export interface RunAblationOptions {
  mainPath: string; // <cacheDir>/<owner>__<repo> — the shared clone
  baseSha: string;
  diff: string;
  hunks: Hunk[]; // walkthrough.hunks
  skippedHunks?: SkippedHunk[];
  recipe: AppRecipe;
  /** Single-scenario form (older callers). */
  reproPath?: string;
  /** One script per scenario, all run against every build. Takes precedence over `reproPath`. */
  scenarios?: { id: string; title: string; path: string }[];
  onProgress?: (msg: string) => void;
}

/** Logic units in the order they'll be tested — mechanical/skipped hunks never included. */
export function logicUnits(hunks: Hunk[], skippedHunks: SkippedHunk[] = []): string[] {
  const skipped = new Set(skippedHunks.map((s) => s.hunkId));
  return hunks.map((h) => h.id).filter((id) => !skipped.has(id));
}

/** After this many runs in a row that couldn't even install or start the app, stop wasting time. */
const MAX_CONSECUTIVE_INFRA_FAILURES = 2;

/** Cache key for a run: the same set of applied hunks always gives the same build. */
export function runKey(unitIds: string[]): string {
  return [...unitIds].sort().join("|");
}

/**
 * Returns undefined when there is nothing to measure: with a single logic unit, "alone" is the
 * finished fix and "everything else" is BASE — both already known from the repro contract.
 */
export async function runAblation(opts: RunAblationOptions): Promise<Ablation | undefined> {
  const allHunks = splitDiffHunks(opts.diff);
  const byId = new Map(allHunks.map((h) => [h.id, h]));
  const units = logicUnits(opts.hunks, opts.skippedHunks).filter((id) => byId.has(id)).slice(0, MAX_UNITS);
  if (units.length <= 1) return undefined;

  const scenarios = opts.scenarios?.length
    ? opts.scenarios
    : opts.reproPath
      ? [{ id: "main", title: "", path: opts.reproPath }]
      : [];
  if (scenarios.length === 0) return undefined;
  const repros = scenarios.map((s) => ({ id: s.id, path: s.path }));

  const cache = new Map<string, RunOutcome>();
  let infraFailures = 0;
  let aborted = false;

  // Every unit alone + every unit left out: the reader sees "3 of 10", not one label for minutes.
  const planned = units.length * 2;
  let done = 0;
  const measure = async (unitIds: string[], label: string) => {
    const key = runKey(unitIds);
    const hit = cache.get(key);
    if (hit) return hit;
    opts.onProgress?.(`${label} (${Math.min(++done, planned)} of ${planned}, about a minute each)`);
    const res = await oneRun({
      mainPath: opts.mainPath,
      baseSha: opts.baseSha,
      apply: unitIds.map((id) => byId.get(id)!),
      recipe: opts.recipe,
      repros,
    });
    cache.set(key, res);
    infraFailures = res.infra ? infraFailures + 1 : 0;
    if (infraFailures >= MAX_CONSECUTIVE_INFRA_FAILURES) aborted = true;
    return res;
  };

  const toRun = (unitIds: string[], mode: AblationRun["mode"], r: RunOutcome): AblationRun => ({
    unitIds,
    mode,
    verdict: r.verdict,
    ...(r.detail ? { detail: r.detail } : {}),
    ...(r.results ? { results: r.results } : {}),
  });

  const runs: AblationRun[] = [];
  for (const unitId of units) {
    if (aborted) break;
    runs.push(toRun([unitId], "alone", await measure([unitId], `Testing "${unitId}" alone`)));
  }
  for (const unitId of units) {
    if (aborted) break;
    const rest = units.filter((id) => id !== unitId);
    runs.push(toRun(rest, "all-but-one", await measure(rest, `Testing everything except "${unitId}"`)));
  }

  const named: AblationScenario[] = scenarios.filter((s) => s.title).map((s) => ({ id: s.id, title: s.title }));
  return { units, runs, ...(scenarios.length > 1 || named.length > 0 ? { scenarios: named } : {}) };
}

/** Per-scenario verdicts of a run (a single-scenario run is its own only result). */
function resultsOf(run: AblationRun, ablation: Ablation): { scenarioId: string; verdict: Verdict }[] {
  if (run.results?.length) return run.results;
  return [{ scenarioId: ablation.scenarios?.[0]?.id ?? "main", verdict: run.verdict }];
}

/** True when at least one run gave a real answer for at least one scenario — an all-"broken" table says nothing. */
export function ablationHasSignal(ablation: Ablation): boolean {
  return ablation.runs.some((r) => resultsOf(r, ablation).some((x) => x.verdict !== "broken"));
}

export type StepVerdict = "needed" | "fixes-alone" | "no-effect" | "not-separable";

/**
 * A step's verdict from the ablation table — "not-separable" when the step's
 * hunks don't map to exactly one tested unit (v1's hunk-granularity limit),
 * or when either of its two runs is missing/broken and gives no signal.
 */
export function verdictForStep(ablation: Ablation, stepHunkIds: string[]): StepVerdict | undefined {
  // A step with no code (the symptoms, the cause in words) makes no claim ablation can measure.
  if (stepHunkIds.length === 0) return undefined;
  const relevant = stepHunkIds.filter((id) => ablation.units.includes(id));
  if (relevant.length !== 1 || relevant.length !== stepHunkIds.length) return "not-separable";
  const unitId = relevant[0];

  const alone = ablation.runs.find((r: AblationRun) => r.mode === "alone" && r.unitIds.length === 1 && r.unitIds[0] === unitId);
  const allBut = ablation.runs.find(
    (r: AblationRun) => r.mode === "all-but-one" && r.unitIds.length === ablation.units.length - 1 && !r.unitIds.includes(unitId)
  );

  // Judge the hunk once per scenario, then combine: a hunk is "needed" if ANY measured behaviour
  // needs it, and "no-effect" only if it made no difference to EVERY behaviour that gave an answer.
  // (With one scenario per PR, the hunks of a second mechanism used to read as "no effect".)
  const ids = new Set<string>();
  for (const r of [alone, allBut]) if (r) for (const x of resultsOf(r, ablation)) ids.add(x.scenarioId);
  const per: (StepVerdict | undefined)[] = [];
  for (const id of ids) {
    const a = alone ? resultsOf(alone, ablation).find((x) => x.scenarioId === id)?.verdict : undefined;
    const b = allBut ? resultsOf(allBut, ablation).find((x) => x.scenarioId === id)?.verdict : undefined;
    if (b === "bug") per.push("needed");
    else if (a === "fixed") per.push("fixes-alone");
    else if (a === "bug" && b === "fixed") per.push("no-effect");
    else per.push(undefined);
  }
  if (per.includes("needed")) return "needed"; // most informative label when both true
  if (per.includes("fixes-alone")) return "fixes-alone";
  const answered = per.filter((v): v is StepVerdict => v !== undefined);
  if (answered.length > 0 && answered.every((v) => v === "no-effect")) return "no-effect";
  return undefined; // runs "broken", or inconclusive — say nothing rather than guess
}
