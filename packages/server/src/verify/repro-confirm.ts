/**
 * repro-confirm.ts — the repro contract (ST12-C), and what to do when it rejects Bob's script.
 *
 * The backend never trusts Bob's own claim that `repro.cjs` works: it runs the script itself
 * against BASE and HEAD and requires `bugPresent: true` on BASE and `false` on HEAD.
 *
 * A rejection used to throw away the whole paid verifier run (up to $2) — although the backend
 * then holds exactly what Bob lacked: what its script really printed on each build. Bob's
 * session still holds everything it learned about the page. So a rejection for a reason that is
 * about THIS script (wrong answer, a crash, no file) gets one cheap `--resume` with those real
 * outputs; anything else (Bob declined with skip.json, budget, no task) does not.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { readFile as readFileAsync } from "node:fs/promises";

import { comparePngs } from "../shots/png-diff.js";
import { runRepro, type ReproResult } from "./ablation.js";
import { loadScenarios, type Scenario } from "./scenarios.js";

export type ReproRun = ReproResult | { error: string };

export interface ConfirmOutcome {
  ok: boolean;
  before?: ReproRun;
  after?: ReproRun;
  /** Why it was rejected (internal wording — translated before a reader sees it). */
  problem?: string;
  /** "wrong": ran but disagreed with the contract. "error": crashed, timed out or didn't exist. */
  kind?: "wrong" | "error";
}

export interface ConfirmOptions {
  reproPath: string;
  baseUrl: string;
  headUrl: string;
  /** Directory the script runs in (it `require`s ./pw.cjs from there). */
  cwd: string;
  beforePng: string;
  afterPng: string;
  /** Failures of individual runs are written here (repro-error.txt), untruncated. */
  logDir?: string;
}

/** One run with one retry on a run ERROR (never on a wrong answer — that is the contract working). */
async function runWithRetry(o: ConfirmOptions, url: string, png: string): Promise<ReproRun> {
  let r = await runRepro(o.reproPath, url, o.cwd, png);
  if ("error" in r) {
    console.warn(`[verify] repro run failed (${r.error.slice(0, 160)}) — retrying once`);
    if (o.logDir) await writeFile(path.join(o.logDir, "repro-error.txt"), r.error).catch(() => {});
    r = await runRepro(o.reproPath, url, o.cwd, png);
  }
  return r;
}

/** BASE then HEAD, one after the other (two Chromiums + two dev servers at once made timeouts likely). */
export async function confirmRepro(o: ConfirmOptions): Promise<ConfirmOutcome> {
  if (!existsSync(o.reproPath)) return { ok: false, kind: "error", problem: "Bob did not write repro.cjs" };
  const before = await runWithRetry(o, o.baseUrl, o.beforePng);
  const after = await runWithRetry(o, o.headUrl, o.afterPng);

  if ("error" in before) return { ok: false, before, after, kind: "error", problem: `repro.cjs failed on BASE: ${before.error}` };
  if ("error" in after) return { ok: false, before, after, kind: "error", problem: `repro.cjs failed on HEAD: ${after.error}` };
  if (!before.bugPresent) return { ok: false, before, after, kind: "wrong", problem: "repro.cjs says the bug is already absent on BASE — not trusted" };
  if (after.bugPresent) return { ok: false, before, after, kind: "wrong", problem: "repro.cjs still says the bug is present on HEAD — not trusted" };
  return { ok: true, before, after };
}

function describeRun(r: ReproRun | undefined): string {
  if (!r) return "(did not run)";
  if ("error" in r) return `FAILED: ${r.error}`;
  return JSON.stringify({ bugPresent: r.bugPresent, measure: r.measure }).slice(0, 700);
}

/** The follow-up Bob gets: the real outputs, the live URLs, and a hard "write, test once, stop". */
export function buildRepairPrompt(o: { baseUrl: string; headUrl: string; outcome: ConfirmOutcome }): string {
  return [
    "The backend ran your `.walkthrough/verify/repro.cjs` itself against both builds and it did not pass the contract.",
    "The two apps were restarted — use THESE urls from now on (your old ones are gone):",
    `- BASE: ${o.baseUrl}`,
    `- HEAD: ${o.headUrl}`,
    "",
    "What your script actually printed:",
    `- on BASE (must be bugPresent: true):  ${describeRun(o.outcome.before)}`,
    `- on HEAD (must be bugPresent: false): ${describeRun(o.outcome.after)}`,
    `Verdict: ${o.outcome.problem ?? "rejected"}`,
    "",
    "Rewrite `.walkthrough/verify/repro.cjs` so it prints `bugPresent: true` on BASE and `false` on HEAD.",
    "You have already learned how this page works while exploring: use it (the selectors that opened the",
    "panel, the values you measured). Do not explore further.",
    "- A step your scenario depends on that didn't happen (a panel that didn't open, a selector that matched",
    "  nothing) must make the script exit non-zero with the reason — never report `bugPresent: false` for it.",
    "- Keep the argument contract: argv[2] = url, argv[3] = optional screenshot path; last stdout line is one JSON",
    "  object `{bugPresent, measure, highlights}`.",
    "- Run it ONCE against each url. If that run doesn't give true/false, stop and write",
    "  `.walkthrough/verify/skip.json` with one plain sentence on why — do not keep trying.",
  ].join("\n");
}

export interface RepairHooks {
  /** Run the Bob resume with this prompt; resolves when it finished (whatever it wrote is on disk). */
  repair: (prompt: string, outcome: ConfirmOutcome) => Promise<void>;
}

/**
 * Confirm, and on a rejection about this script itself give Bob exactly one chance to fix it.
 * `repaired` tells whether the resume ran (so the caller can account for its cost).
 */
export async function confirmWithRepair(
  o: ConfirmOptions,
  hooks?: RepairHooks
): Promise<{ outcome: ConfirmOutcome; repaired: boolean }> {
  const first = await confirmRepro(o);
  if (first.ok || !hooks) return { outcome: first, repaired: false };
  await hooks.repair(buildRepairPrompt({ baseUrl: o.baseUrl, headUrl: o.headUrl, outcome: first }), first);
  return { outcome: await confirmRepro(o), repaired: true };
}

// ---------------------------------------------------------------------------
// Several scenarios (one per user-visible problem) — see scenarios.ts
// ---------------------------------------------------------------------------

export interface ScenarioResult {
  scenario: Scenario;
  outcome: ConfirmOutcome;
  beforePng: string;
  afterPng: string;
  /** Both frames exist and look different — worth showing as a before/after pair. */
  visible: boolean;
  /** Both frames exist but are pixel-identical. */
  identical: boolean;
}

export interface ScenariosOptions {
  verifyDir: string;
  baseUrl: string;
  headUrl: string;
  /** Where the frames go: `<id>-before.png` / `<id>-after.png`. */
  frameDir: string;
  logDir?: string;
  fallbackTitle?: string;
}

export async function confirmScenarios(o: ScenariosOptions): Promise<ScenarioResult[]> {
  const scenarios = await loadScenarios(o.verifyDir, o.fallbackTitle);
  const out: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const beforePng = path.join(o.frameDir, `${scenario.id}-before.png`);
    const afterPng = path.join(o.frameDir, `${scenario.id}-after.png`);
    const outcome = await confirmRepro({
      reproPath: path.join(o.verifyDir, scenario.file),
      baseUrl: o.baseUrl,
      headUrl: o.headUrl,
      cwd: o.verifyDir,
      beforePng,
      afterPng,
      logDir: o.logDir,
    });
    let visible = false;
    let identical = false;
    if (outcome.ok && existsSync(beforePng) && existsSync(afterPng)) {
      const cmp = comparePngs(await readFileAsync(beforePng), await readFileAsync(afterPng));
      identical = cmp?.identical === true;
      visible = cmp !== null && !identical;
    }
    out.push({ scenario, outcome, beforePng, afterPng, visible, identical });
  }
  return out;
}

/** What is wrong with a set of results, one line per scenario that needs work (empty = all good). */
export function scenarioProblems(results: ScenarioResult[]): string[] {
  if (results.length === 0) return ["No scenario script was written (no scenarios.json and no repro.cjs)."];
  const lines: string[] = [];
  for (const r of results) {
    const head = `- "${r.scenario.id}" (${r.scenario.file}) — ${r.scenario.title}:`;
    if (!r.outcome.ok) {
      lines.push(
        `${head} ${r.outcome.problem ?? "rejected"}.\n    on BASE: ${describeRun(r.outcome.before)}\n    on HEAD: ${describeRun(r.outcome.after)}`
      );
    } else if (r.identical) {
      lines.push(
        `${head} passes the contract, but its BASE and HEAD screenshots are pixel-identical, so a reader sees no difference. ` +
          `Make the scenario END in the state where the problem is visible on screen (open the panel/menu that overlaps, use the ` +
          `viewport where it shows) and take the screenshot there. If this problem truly cannot be seen in a still, say so in ` +
          `its "title" and leave it.`
      );
    }
  }
  return lines;
}

export function buildScenarioRepairPrompt(o: { baseUrl: string; headUrl: string; problems: string[] }): string {
  return [
    "The backend ran your scenario scripts itself against both builds. Some need one more fix.",
    "The two apps were restarted — use THESE urls from now on (your old ones are gone):",
    `- BASE: ${o.baseUrl}`,
    `- HEAD: ${o.headUrl}`,
    "",
    "What needs fixing:",
    ...o.problems,
    "",
    "Fix only those scripts (and `.walkthrough/verify/scenarios.json` if a file name or title changes).",
    "You already learned how this page works while exploring — use it; do not explore further.",
    "- A step a scenario depends on that didn't happen (a panel that didn't open, a selector that matched",
    "  nothing) must make the script exit non-zero with the reason — never report `bugPresent: false` for it.",
    "- Keep the contract: argv[2] = url, argv[3] = optional screenshot path; last stdout line is one JSON",
    "  object `{bugPresent, measure, highlights}`; true on BASE, false on HEAD.",
    "- Run each fixed script ONCE against each url, then stop. If one still can't work, remove it from",
    "  scenarios.json rather than keep trying.",
  ].join("\n");
}

/**
 * Confirm every scenario; if any fails the contract or shows nothing, give Bob ONE resume with all of
 * it at once, then confirm again. `repaired` tells whether the resume ran (so it can be accounted for).
 */
export async function confirmScenariosWithRepair(
  o: ScenariosOptions,
  repair?: (prompt: string) => Promise<void>
): Promise<{ results: ScenarioResult[]; repaired: boolean }> {
  const first = await confirmScenarios(o);
  const problems = scenarioProblems(first);
  if (problems.length === 0 || !repair) return { results: first, repaired: false };
  await repair(buildScenarioRepairPrompt({ baseUrl: o.baseUrl, headUrl: o.headUrl, problems }));
  return { results: await confirmScenarios(o), repaired: true };
}
