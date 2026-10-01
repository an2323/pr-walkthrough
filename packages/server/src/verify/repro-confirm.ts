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

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { readFile as readFileAsync } from "node:fs/promises";

import { comparePngs } from "../shots/png-diff.js";
import { isPhoneFrame } from "../shots/frames.js";
import { runRepro, type ReproResult } from "./ablation.js";
import { loadScenarios, MAX_SCENARIOS, type Scenario } from "./scenarios.js";

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
  /** The walkthrough's symptom texts: a scenario tied to one must measure the visible claims it makes. */
  symptomTexts?: string[];
  /** One plain line per scenario as it is tried (the screen otherwise sits silent for minutes). */
  onProgress?: (label: string) => void;
}

/**
 * A pair whose labels read the same on both builds ("AI badge" / "AI badge" on #10682, "Menu trigger
 * button" twice on #12053) tells the reader nothing — the label is where the difference is named.
 * The prompt says so; Bob didn't follow it twice, so it is checked here.
 */
export function sameLabelsOnBothBuilds(r: ScenarioResult): string[] | undefined {
  if (!r.outcome.ok || !r.visible) return undefined;
  const labels = (side: unknown) =>
    ((side as { highlights?: { label?: unknown }[] } | undefined)?.highlights ?? [])
      .map((h) => (typeof h.label === "string" ? h.label.trim().toLowerCase() : ""))
      .filter(Boolean)
      .sort();
  const before = labels(r.outcome.before);
  const after = labels(r.outcome.after);
  if (before.length === 0 || before.join("|") !== after.join("|")) return undefined;
  return before;
}

const PHONE_ONLY = /\b(mobile|phones?|small screens?|narrow screens?|touch)\b/i;

/**
 * Every confirmed scenario was captured on a phone although some symptom isn't phone-only: the start
 * screen then shows a narrow phone pair instead of the desktop change (#10295, twice, although the
 * prompt said to keep the desktop viewport). Returns the one problem line, or nothing.
 */
export function missingDesktopScenario(results: ScenarioResult[], symptomTexts: string[] = []): string | undefined {
  const ok = results.filter((r) => r.outcome.ok && existsSync(r.beforePng));
  if (ok.length === 0 || symptomTexts.length === 0) return undefined;
  const desktopClaims = symptomTexts.filter((t) => !PHONE_ONLY.test(t));
  if (desktopClaims.length === 0) return undefined;
  if (!ok.every((r) => isPhoneFrame(readFileSync(r.beforePng)))) return undefined;
  return (
    `- Every scenario runs at a phone-sized viewport, but these symptoms are not about phones: ` +
    desktopClaims.map((t) => `"${t}"`).join("; ") +
    `. Keep (or add) one scenario at the app's normal desktop viewport that shows the change there — its ` +
    `screenshots are the main before/after pair. Phone-only claims are measured on an extra phone-sized page ` +
    `inside a script, never by moving a whole scenario to a phone.`
  );
}

/**
 * Symptoms no scenario was even written for (#10199: three symptoms, two scripts — "hidden behind the
 * properties popup" got no attempt, so its card had no picture). A scenario that was written and failed
 * counts as tried: that is a different case and is not asked again. Only judged when Bob tags scenarios
 * with `symptomIndex` at all, and only while there is room under MAX_SCENARIOS.
 */
export function symptomsWithoutScenario(results: ScenarioResult[], symptomTexts: string[] = []): string | undefined {
  const tagged = new Set(results.map((r) => r.scenario.symptomIndex).filter((i): i is number => i !== undefined));
  if (tagged.size === 0 || results.length >= MAX_SCENARIOS) return undefined;
  const missing = symptomTexts.map((t, i) => ({ t, i })).filter(({ i }) => !tagged.has(i)).slice(0, MAX_SCENARIOS - results.length);
  if (missing.length === 0) return undefined;
  return (
    `- No scenario was written for ` +
    missing.map(({ t, i }) => `symptom [${i}] "${t}"`).join("; ") +
    `. Write one script for each (same contract, \`symptomIndex\` set) so it gets its own before/after picture. ` +
    `Start from your closest working script (same setup, same helpers) and change only the steps this symptom ` +
    `needs; write the file FIRST, then run it — no page dumps or element listings. If it truly can't be shown ` +
    `in the running app, leave it out — do not force it.`
  );
}

/** A symptom text that says which of two things is drawn over the other. */
const STACKING_CLAIM = /\b(on top of|covers?|covering|covered|behind|underneath|under|above|over(?:lap)?s?|hides?|hidden)\b/i;
/** A measurement that says which element is on top (any reasonable key name, or an elementFromPoint result). */
const STACKING_MEASURE = /onTop|on_top|topmost|atPoint|fromPoint|elementAt|covers|covered|above|below|stack|zOrder|hitTest/i;

/**
 * Claims the scenario's own symptom text makes but its measurement doesn't cover. The text is fact-checked
 * against the measurement later — an unmeasured claim can't be checked (#10295: "the sidebar covers the
 * menu on mobile" was never measured, and was false). Only stacking is detected for now: it is the claim a
 * screenshot can't settle and the one that was wrong.
 */
export function unmeasuredClaims(r: ScenarioResult, symptomTexts: string[] = []): string[] {
  const idx = r.scenario.symptomIndex;
  if (idx === undefined || !r.outcome.ok) return [];
  const text = symptomTexts[idx];
  if (!text || !STACKING_CLAIM.test(text)) return [];
  const keys = JSON.stringify((r.outcome.before as { measure?: unknown } | undefined)?.measure ?? {});
  return STACKING_MEASURE.test(keys) ? [] : [text];
}

export async function confirmScenarios(o: ScenariosOptions): Promise<ScenarioResult[]> {
  const scenarios = await loadScenarios(o.verifyDir, o.fallbackTitle);
  const out: ScenarioResult[] = [];
  for (const [k, scenario] of scenarios.entries()) {
    o.onProgress?.(`Trying "${scenario.title}" on the old and the new version (${k + 1} of ${scenarios.length})`);
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
export function scenarioProblems(results: ScenarioResult[], symptomTexts: string[] = []): string[] {
  if (results.length === 0) return ["No scenario script was written (no scenarios.json and no repro.cjs)."];
  const lines: string[] = [];
  // Identical frames only matter when NOTHING shows a difference: with one visible pair the reader
  // already sees the change, and the identical scenario still gives its BASE frame as a symptom card.
  // (On #10295 this alone paid ~$1 per run for a rewrite that added nothing visible.)
  const anyVisible = results.some((r) => r.visible);
  for (const r of results) {
    const head = `- "${r.scenario.id}" (${r.scenario.file}) — ${r.scenario.title}:`;
    if (!r.outcome.ok) {
      lines.push(
        `${head} ${r.outcome.problem ?? "rejected"}.\n    on BASE: ${describeRun(r.outcome.before)}\n    on HEAD: ${describeRun(r.outcome.after)}`
      );
    } else if (unmeasuredClaims(r, symptomTexts).length > 0) {
      lines.push(
        `${head} passes the contract, but its symptom says "${unmeasuredClaims(r, symptomTexts)[0]}" and its \`measure\` ` +
          `doesn't say which element is on top. Add it: at a point both elements cover, record what ` +
          `\`document.elementFromPoint\` returns (e.g. \`"onTop": "menu"\`), at the viewport the text names — on both builds.`
      );
    } else if (r.identical && !anyVisible) {
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
  repair?: (prompt: string, why: { onlyMissing: boolean }) => Promise<void>
): Promise<{ results: ScenarioResult[]; repaired: boolean; flaky: string[] }> {
  let results = await confirmScenarios(o);
  const allProblems = (rs: ScenarioResult[]) => {
    const p = scenarioProblems(rs, o.symptomTexts);
    for (const r of rs) {
      const same = sameLabelsOnBothBuilds(r);
      if (same)
        p.push(
          `- "${r.scenario.id}" (${r.scenario.file}) — ${r.scenario.title}: its labels are the same on both builds ` +
            `(${same.map((l) => `"${l}"`).join(", ")}). A label names what is wrong on BASE ("Badge stuck to the text") ` +
            `and what is fixed on HEAD ("Badges aligned right") — at most 5 plain words, different on the two builds.`
        );
    }
    const desktop = missingDesktopScenario(rs, o.symptomTexts);
    const untried = symptomsWithoutScenario(rs, o.symptomTexts);
    return [...p, ...(desktop ? [desktop] : []), ...(untried ? [untried] : [])];
  };
  let problems = allProblems(results);
  const flaky: string[] = [];
  // Only a script that failed can be flaky; a missing scenario or a wrong label isn't helped by a re-run.
  if (problems.length > 0 && results.some((r) => !r.outcome.ok)) {
    await logProblems(o, "first check", problems);
    // A second $0 check before paying for a rewrite: a rehearsal showed saved, previously confirmed
    // scripts failing once and passing on the next run — that is a flaky run, not a broken script.
    const again = await confirmScenarios(o);
    results = results.map((r, i) => {
      const b = again.find((x) => x.scenario.id === r.scenario.id) ?? again[i];
      if (!r.outcome.ok && b?.outcome.ok) {
        flaky.push(r.scenario.id);
        return b;
      }
      return r;
    });
    problems = allProblems(results);
    if (flaky.length > 0) console.warn(`[verify] passed on a second check (flaky): ${flaky.join(", ")}`);
  }
  if (problems.length === 0 || !repair) return { results, repaired: false, flaky };
  await logProblems(o, "sent to repair", problems);
  const untried = symptomsWithoutScenario(results, o.symptomTexts);
  await repair(buildScenarioRepairPrompt({ baseUrl: o.baseUrl, headUrl: o.headUrl, problems }), {
    onlyMissing: problems.length === 1 && problems[0] === untried,
  });
  results = await confirmScenarios(o);
  const left = allProblems(results);
  if (left.length > 0) await logProblems(o, "after repair", left);
  return { results, repaired: true, flaky };
}

/** What the contract rejected, and why — the first question after any failed or repaired run. */
async function logProblems(o: ScenariosOptions, when: string, problems: string[]): Promise<void> {
  console.warn(`[verify] scenario problems (${when}):\n${problems.join("\n").slice(0, 2000)}`);
  if (o.logDir) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path.join(o.logDir, "scenario-problems.txt"), `== ${when}\n${problems.join("\n")}\n\n`).catch(() => {});
  }
}
