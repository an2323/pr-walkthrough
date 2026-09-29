/**
 * bob-verifier.ts — ST6e/ST12-C: Bob reproduces a PR's user-visible change in
 * the running app and writes ONE reusable script that PROVES it, instead of
 * a one-off screenshot script whose claims we'd have to take on faith.
 *
 * Division of labour:
 *  - The backend installs and starts the app at BASE and HEAD (recipes.ts,
 *    app-servers.ts) and always stops it again — Bob never manages servers.
 *  - Bob (custom mode `pr-verifier`: read + edit + execute) reads the
 *    walkthrough and the changed source, decides the scenario, and writes
 *    `.walkthrough/verify/repro.cjs <url> [pngPath]` — a script that runs the
 *    scenario against WHATEVER url it's given and prints one JSON line
 *    `{"bugPresent": boolean, "measure": {...}, "highlights": [...]}`. It may
 *    decline ("skip") when the change isn't visible in a screenshot.
 *  - The backend does NOT trust Bob's own claim that the script works: it
 *    re-runs repro.cjs ITSELF against base.url and head.url and requires
 *    `bugPresent: true` on BASE, `false` on HEAD — this is the repro
 *    contract (ST12-C). Only a confirmed script is trusted for anything
 *    downstream: the before/after screenshots here, and later the ablation
 *    runner (verify/ablation.ts), which reuses this exact same script
 *    against many disposable BASE-plus-partial-patch checkouts, at $0,
 *    without involving Bob again.
 *  - The confirmed repro.cjs (+ its pw.cjs helper) is persisted to
 *    data/verify/{owner}/{repo}/{number}/ — committed, not a throwaway
 *    build artifact: it's the evidence itself, reviewable like the shots.
 *
 * Safety: Bob's workspace is the PR's HEAD worktree in the throwaway clone
 * cache (never this repo); it may write only under `.walkthrough/verify/`;
 * its environment carries BOB_API_KEY and nothing else from our `.env`; its
 * process group is killed afterwards; the `execute` mode file is removed.
 * `execute` is still real code execution on this machine — which is why only
 * repos with a recipe (an allowlist) get here at all.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ProgressStage, Shots, Walkthrough } from "@pr-walkthrough/shared";

import { assertBudget, recordSpend } from "../analyzer/budget.js";
import { outOfCredits, summarizeEvents } from "../analyzer/bob-shell.js";
import { bobCommand, inRehearsal } from "../analyzer/bob-command.js";
import { NdjsonBuffer } from "../analyzer/ndjson-buffer.js";
import { ensureWorktree } from "../git/workspace.js";
import { annotateShot } from "../shots/annotate.js";
import { isPhoneFrame, isPhoneSize, pickMainIndex, pngDimensions } from "../shots/frames.js";
import { ensureInstalled, scrubbedEnv, startApp, warmUp, type AppServer } from "./app-servers.js";
import { focusOnChange, normalizeHighlights, maybeCropRegion } from "./highlights.js";
import { recipeFor, type AppRecipe } from "./recipes.js";
import { confirmScenariosWithRepair } from "./repro-confirm.js";
import { changedRegion, comparePngs } from "../shots/png-diff.js";
import { listSymptomTexts } from "./symptom-shots.js";
import { IDENTICAL_FRAMES_NOTE, NO_FRAMES_NOTE } from "./shots-status.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const MODE_SLUG = "pr-verifier";
/** A highlight covering more than this share of the frame is dropped (the prompt says so too). */
const MAX_BOX_AREA = 0.6;
const PLAYWRIGHT = createRequire(import.meta.url).resolve("playwright");
const execFileAsync = promisify(execFile);

export interface VerifyOptions {
  walkthrough: Walkthrough;
  /** Where the final PNGs go, e.g. data/shots/{owner}/{repo}/{number}. */
  outDir: string;
  maxCost?: number;
  /** The PR's unified diff, shown to Bob so it doesn't have to read files to learn what changed. */
  diff?: string;
  onStage?: (stage: ProgressStage, label: string) => void;
  /** Raw `bob run --format stream-json` events, for the progress screen. */
  onEvent?: (e: unknown) => void;
  /**
   * Finish a verifier session that was already paid for but whose repro was rejected (or that ran
   * out of budget mid-way): skip the first Bob run, keep `.walkthrough/verify/` as it is, and go
   * straight to the backend confirmation and, if that fails, the one repair resume. `spent` is what
   * the task has cost so far (its cumulative cost — the resume's cap is built on top of it).
   */
  recover?: { taskId: string; spent: number };
  /**
   * $0 re-render: no Bob at all. Copies the scenario scripts saved by an earlier confirmed run
   * (data/verify/<owner>/<repo>/<n>/) back into the working directory, re-confirms them against the
   * live builds and rebuilds every frame, crop and card with the CURRENT rendering code. Nothing to
   * repair (there is no session to resume), so a script that no longer holds simply drops out.
   */
  reuseSaved?: boolean;
}

export type VerifyResult =
  | {
      status: "ok";
      /**
       * Absent when the bug was measured but BASE and HEAD look the same in a still
       * (see `shotsNote`) — the repro and ablation still apply.
       */
      shots?: Shots;
      /** Plain-words reason there are no before/after frames although the repro worked. */
      shotsNote?: string;
      costUsd: number;
      reproPath: string;
      /** Per-symptom BASE screenshot paths (relative to outDir), keyed by item index. */
      symptomSrcs?: Map<number, string>;
      /** The repro's own measurements at BASE and HEAD — reused by the revise step instead of re-running the app. */
      measures?: { base: unknown; head: unknown };
      /** Every confirmed scenario (one per user-visible problem), scripts persisted next to `reproPath`. */
      scenarios?: { id: string; title: string; path: string }[];
    }
  | {
      status: "skipped";
      reason: string;
      costUsd: number;
      /**
       * "declined": the verifier itself judged the change not worth a screenshot and said so in
       * plain words (its `skip.json`) — show that text as written. "failed" (default): something
       * went wrong — the reason is internal and gets translated before the reader sees it.
       */
      kind?: "declined" | "failed";
    };

/** Does this repo have a way to start its app at all? (cheap pre-check, no side effects) */
export function canVerify(repoFullName: string): boolean {
  const [owner, repo] = repoFullName.split("/");
  return !!recipeFor(owner, repo);
}

export function buildPrompt(wt: Walkthrough, recipe: AppRecipe, baseUrl: string, headUrl: string, diff = ""): string {
  const files = [...new Set(wt.hunks.map((h) => h.file))];
  const steps = wt.steps
    .filter((s) => !s.minor)
    .map((s) => `- ${s.headline ?? s.title}${s.say ? ` — ${s.say}` : ""}`)
    .join("\n");
  const scenario = (wt.verification?.scenario ?? []).map((l) => `- ${l}`).join("\n") || "(none)";
  const symptomTexts = listSymptomTexts(wt);
  const symptomsBlock =
    symptomTexts.length === 0
      ? ""
      : `
## The user-visible problems the walkthrough lists (0-based index)
${symptomTexts.map((t, i) => `${i}. ${t}`).join("\n")}
Each one of these that can be SEEN on screen gets its own scenario (see "Your job").
`;
  const { width, height } = recipe.viewport;
  return `You are checking a pull request by writing a script that PROVES its user-visible change is
real: one script, run against a URL you're given, that reports whether the bug is present there.
The backend will re-run your finished script itself against BASE and HEAD before trusting it, and
again, later, against other partial versions of the fix — so it must genuinely work standalone, not
just print what you expect.

## The app is ALREADY RUNNING — do not install, start or stop any server
- BASE (before the PR): ${baseUrl}
- HEAD (after the PR):  ${headUrl}
Your workspace is the HEAD source. BASE versions of the changed files are under \`.walkthrough/base/\`;
the full diff is \`.walkthrough/pr.diff\`.

## What the PR does
Title: ${wt.plain?.title ?? wt.pr.title}
Problem: ${wt.plain?.problem ?? "(see steps)"}
Fix: ${wt.plain?.fix ?? "(see steps)"}
Changed files:
${files.map((f) => `- ${f}`).join("\n")}
Steps of the analysis:
${steps}
Scenario ideas from the analysis (not verified, may be wrong):
${scenario}
${symptomsBlock}
## The change itself
${diffBlock(diff)}

## App tips
${recipe.hints}

## Your job: one scenario per visible problem
A PR can fix more than one thing the user sees. Write ONE script per visible problem, at most 3, each
proving its own problem — this is what gives every problem its own before/after picture, and lets the
backend measure each fix separately.
1. For each visible problem pick ONE short scenario (at most 6 UI actions) that ENDS in a state where the
   problem is visible on screen — the panel that overlaps is open, the element that overflows is on
   screen — and take the screenshot in that state. Viewports: a problem that shows on a desktop gets its
   script at ${width}×${height} — the reader's main before/after picture is ALWAYS a desktop frame when
   the change is visible there, so do not swap it for a phone script. A problem that only shows on a small
   screen gets its own script on a phone: viewport 390×844 AND \`deviceScaleFactor: 2\` (a phone frame at 1×
   is blurry) — \`const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }); const page = await ctx.newPage();\`.
   A script uses the SAME viewport whichever url it is given. If a change shows on BOTH desktop and
   phone, write both scripts (two scenarios). Read only what you need for a reliable selector — do not guess.
   The signal for "the problem is present" must come from that visible state (an element's bounding box
   overflowing, a z-order via \`document.elementFromPoint\`, a class, visible text) — not from a value that
   leaves both screenshots identical. If a screenshot of BASE and HEAD would look the same, you picked a
   state that does not show the problem: go on until it does.
2. If the change has no user-visible effect at all (performance, internal refactor, types, tests, build
   config), do not force it: write \`{"skip": "<one sentence why>"}\` to \`.walkthrough/verify/skip.json\`,
   print it, and stop.
3. For each scenario write a CommonJS script \`.walkthrough/verify/<name>.cjs\`, run as
   \`node <name>.cjs <url> [pngPath]\` (argv[2] = the app url to check, argv[3] = optional screenshot path).
   A tested Playwright helper is already there — use it, do not look for browsers or Playwright yourself:
   \`const { launch } = require("./pw.cjs"); const browser = await launch();\`
   Each script must, for THAT ONE url:
   - open a page at its viewport, go to the url, run the scenario (≤ 30 s per action);
   - measure the signal and decide \`bugPresent\` (boolean) from it — not from which url string was passed
     in; the same logic must work no matter which build is running there;
   - if argv[3] is given, save a screenshot there, and also return the highlights (see "Highlights" below);
   - print EXACTLY ONE line of JSON as your last line of output:
     \`{"bugPresent": true, "measure": {...the numbers you used...}, "highlights": [...]}\`
   - only say \`bugPresent: false\` after the scenario actually ran and the signal was measured. If a step it
     depends on didn't happen (a panel that didn't open, a selector that matched nothing) it must exit
     non-zero with the reason on stderr — never report \`false\` because it found nothing. Put the evidence
     the scenario ran in \`measure\`. "Not found" is a failed script, not a fixed bug.
   Then write \`.walkthrough/verify/scenarios.json\`:
   \`[{"id": "short-id", "file": "<name>.cjs", "title": "<plain words: the behaviour it checks>", "symptomIndex": <index from the list above, if any>}]\`
4. Test each script against BOTH ${baseUrl} and ${headUrl}: \`bugPresent: true\` for BASE, \`false\` for
   HEAD, and a screenshot that visibly differs. At most 3 runs of any one script (probes included). Your
   budget is small: if a scenario still won't work after that, drop it from scenarios.json instead of
   exploring on.
   Work in this order: the change is above, so write the scripts FIRST from what you know, then test them.
   Do not read more source than a selector needs. When a run disagrees, do not go off exploring the page in
   throwaway probes — fix the script, or stop: the backend re-runs your files and, if one disagrees or shows
   nothing, sends you its real outputs for one final fix. A script left half-fixed is worth nothing; a probe
   is worth nothing until it is in a script.

## Highlights (what the script returns in \`"highlights"\`)
A highlight is \`{x, y, w, h, label, pair}\`, x/y/w/h as fractions (0..1) of the viewport.
- **Desktop scripts: 1–3 boxes. Each box is the WHOLE element its label names:** take
  \`el.getBoundingClientRect()\` of that element and divide by the viewport width/height. Never a slice of it —
  do not cap its height, do not pick an inner icon or its first row instead of the panel, do not box the
  button that opened a panel when the label talks about the panel. An element sticking out of the viewport is
  clamped to the viewport. If the element fills more than about 60% of the screen a box says nothing: leave the
  box out (a label without a box is not allowed either — return no highlight for it).
- **Phone scripts (viewport width under 700): return \`"highlights": []\`.** On a phone the panel or menu IS the
  screen, so a rectangle marks nothing, and anything drawn on a narrow picture covers content. The reader
  sees the plain frame; the words are in the walkthrough text.
- **label**: at most 5 plain words a non-engineer understands ("Sidebar still open", "Menu opened") — no
  property names, numbers, comparisons or sentences. It says what is wrong when \`bugPresent\` and what is fixed
  when not. The backend places the label itself, in empty space next to the box — do not try to.
- **pair**: the box for the SAME element on the other build has the same "pair" id (\`"pair": "sidebar"\` in both
  runs). Every pair has its OWN id; two different boxes on one screenshot never share one.
- **An element the fix removes** (a panel that now closes by itself): on the build where it is gone, you cannot
  measure it — return \`{"pair": "<same id>", "label": "Sidebar closed by itself", "gone": true}\` with NO
  coordinates. The backend draws a dashed outline where it stood on the other build.

## Rules
- Write files ONLY under \`.walkthrough/verify/\` — not \`/tmp\`, not anywhere else. Never edit the
  repository's source.
- Do not install packages. No network access except the two app URLs above.
- Final answer: print each script's last JSON line from your BASE test run (or the skip JSON).
`;
}

/**
 * The change as Bob needs to read it: the non-test diff, trimmed. Without it Bob spends its few
 * paid turns opening files just to learn what the PR did (the analysis already knows, and the
 * backend has the diff for free).
 */
export function diffBlock(diff: string, maxChars = 7000): string {
  if (!diff.trim()) return "(see .walkthrough/pr.diff)";
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => !/^diff --git a\/\S*(?:\.(?:test|spec)\.|__tests__|__snapshots__|\.snap\b)/.test(p));
  const text = parts.join("").trim();
  if (text.length <= maxChars) return "```diff\n" + text + "\n```";
  return "```diff\n" + text.slice(0, maxChars).trimEnd() + "\n… (trimmed — the full diff is .walkthrough/pr.diff)\n```";
}

function modeYaml(): string {
  return [
    "customModes:",
    `  - slug: ${MODE_SLUG}`,
    "    name: PR Verifier (screenshots)",
    "    roleDefinition: >-",
    "      You reproduce a pull request's visible change in an already-running app with a",
    "      Playwright script and return before/after screenshots with highlight boxes. You",
    "      write files only under .walkthrough/verify/ and never edit the repository's source.",
    "    whenToUse: Before/after screenshots for a pull-request walkthrough.",
    "    groups:",
    "      - read",
    "      - edit",
    "      - execute",
    "",
  ].join("\n");
}

export { outOfCredits };

type BobRunResult = { events: unknown[]; ms: number } & ReturnType<typeof summarizeEvents>;

async function runBobVerifier(
  prompt: string,
  workspace: string,
  maxCost: number,
  runDir: string,
  onEvent?: (e: unknown) => void,
  /** Continue this task instead of starting one; the prompt is then a follow-up message. */
  resumeTaskId?: string
): Promise<BobRunResult> {
  const args = [
    "run", "--format", "stream-json",
    ...(resumeTaskId ? ["--resume", resumeTaskId] : ["--mode", MODE_SLUG]),
    "--workspace", workspace, "--max-cost", String(maxCost),
    "--max-turns", "40", "--disable-mcp", "--disable-subagents", "--trust", "--accept-license",
    // `--resume` does not read a follow-up from stdin (it silently replays the old transcript at
    // $0); the message must be the trailing positional argument.
    ...(resumeTaskId ? [prompt] : []),
  ];
  const started = Date.now();
  const cmd = bobCommand();
  const env = scrubbedEnv({ ...(process.env.BOB_API_KEY ? { BOB_API_KEY: process.env.BOB_API_KEY } : {}), ...cmd.env });
  return new Promise((resolve, reject) => {
    const child = spawn(cmd.bin, [...cmd.preArgs, ...args], { cwd: workspace, env, detached: true, timeout: 600_000 });
    let stdout = "";
    const live = new NdjsonBuffer();
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
      if (onEvent) for (const e of live.push(d.toString())) onEvent(e);
    });
    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => {
      process.stderr.write(d);
      stderrTail = (stderrTail + d).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", async () => {
      // Anything Bob left running (a stray browser, a server it started anyway) goes with its group.
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      if (onEvent) for (const e of live.flush()) onEvent(e);
      await writeFile(path.join(runDir, resumeTaskId ? "events-repair.ndjson" : "events.ndjson"), stdout).catch(() => {});
      const events = stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return l; }
      });
      const summary = summarizeEvents(events);
      // The service says so on stderr when the key has no credit left — the run then just stops, with no
      // result event and no cost, and everything downstream would blame the script instead.
      if (outOfCredits(stderrTail)) summary.errorMessage = "Bob has no credits left: " + stderrTail.trim().split("\n").pop();
      resolve({ events, ms: Date.now() - started, ...summary });
    });
    child.stdin.end(resumeTaskId ? "" : prompt);
  });
}

async function assertBrowserWorks(): Promise<void> {
  const { chromium } = await import("playwright");
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch (err) {
    const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    throw new Error(
      `headless browser can't start (${first.slice(0, 160)}) — run: pnpm --filter @pr-walkthrough/server exec playwright install chromium-headless-shell`
    );
  }
}


/**
 * Everything that can be checked for $0 — run BEFORE the multi-minute installs and long before
 * Bob is started. A missing binary, an unset key, an exhausted budget or a browser that can't
 * launch used to surface only after 10+ minutes of setup (or after Bob had already been paid).
 */
async function preflight(maxCost: number): Promise<string | undefined> {
  try {
    const cmd = bobCommand();
    await execFileAsync(cmd.bin, [...cmd.preArgs, "--version"], { timeout: 20_000, env: scrubbedEnv(cmd.env) });
  } catch {
    return "the screenshot tool (bob) isn't available on this server";
  }
  if (!process.env.BOB_API_KEY && !inRehearsal()) return "the screenshot tool isn't configured on this server (no BOB_API_KEY)";
  try {
    await assertBudget(maxCost);
  } catch {
    return "the spending limit for analyses has been reached";
  }
  try {
    await assertBrowserWorks();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return undefined;
}

/** annotateShot can fail (Chromium hiccup, huge capture) — the raw frame is still good evidence. */
async function annotateOrRaw(raw: string, annotated: string, ...rest: [Parameters<typeof annotateShot>[2], Parameters<typeof annotateShot>[3], Parameters<typeof annotateShot>[4]]): Promise<string> {
  // A phone frame is shown as captured: a box on a phone screen marks nothing and text on it covers content.
  try {
    if (isPhoneFrame(await readFile(raw))) return path.basename(raw);
  } catch { /* unreadable → let annotateShot report it below */ }
  try {
    await annotateShot(raw, annotated, ...rest);
    return path.basename(annotated);
  } catch (err) {
    console.warn("[verify] annotate failed — using the raw frame:", err instanceof Error ? err.message : err);
    return path.basename(raw);
  }
}

export async function verifyShots(opts: VerifyOptions): Promise<VerifyResult> {
  const { walkthrough: wt, outDir, onStage, onEvent, recover, reuseSaved } = opts;
  const offline = !!recover || !!reuseSaved; // no first Bob run
  const maxCost = opts.maxCost ?? Number(process.env.VERIFY_MAX_COST ?? 2);
  const repairMax = Number(process.env.VERIFY_REPAIR_MAX_COST ?? 1);
  const [owner, repo] = wt.pr.repo.split("/");
  const recipe = recipeFor(owner, repo);
  if (!recipe) return { status: "skipped", reason: `no app recipe for ${wt.pr.repo}`, costUsd: 0 };
  if (!wt.pr.baseSha || !wt.pr.headSha) return { status: "skipped", reason: "walkthrough has no base/head SHA", costUsd: 0 };

  // Recovering costs at most the repair; a fresh run costs the run (+ the repair if it comes to that);
  // a re-render costs nothing (the budget, tool and key checks don't apply).
  const notReady = reuseSaved ? undefined : await preflight(recover ? repairMax : maxCost);
  if (notReady) return { status: "skipped", reason: notReady, costUsd: 0 };
  await mkdir(outDir, { recursive: true });

  const mainPath = path.join(GIT_CACHE_DIR, `${owner}__${repo}`);
  const baseWt = await ensureWorktree(mainPath, wt.pr.baseSha);
  const headWt = await ensureWorktree(mainPath, wt.pr.headSha);
  if (!existsSync(path.join(headWt, ".walkthrough", "pr.diff"))) {
    return { status: "skipped", reason: "the analysis files aren't in the workspace (walkthrough/pr.diff missing)", costUsd: 0 };
  }

  const servers: AppServer[] = [];
  const modePath = path.join(headWt, ".bob", "custom_modes.yaml");
  const previousMode = existsSync(modePath) ? await readFile(modePath, "utf-8") : undefined;
  const verifyDir = path.join(headWt, ".walkthrough", "verify");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(ROOT, "data/runs", `${stamp}-${repo}-${wt.pr.number}-verify${recover ? "-recover" : ""}`);
  let costUsd = recover?.spent ?? 0;
  // What was actually spent, so the ledger gets exactly one row per Bob session on EVERY exit path
  // (success, skip, or an exception after money was spent). A recovered session's first run is
  // already in the ledger from when it happened — only the repair is new.
  let firstRun: BobRunResult | undefined;
  let repairRun: BobRunResult | undefined;
  let repairSpentBefore = 0;
  let outcomeOk = false;
  let outcomeNote: string | undefined;

  try {
    onStage?.("app", "Preparing the app at BASE and HEAD (reusing installed dependencies)");
    // Sequential on purpose: the second worktree can then clone the first one's install.
    const baseInstall = await ensureInstalled(recipe, baseWt);
    const headInstall = await ensureInstalled(recipe, headWt, { donor: baseWt });
    console.log(`[verify] dependencies: BASE ${baseInstall}, HEAD ${headInstall}`);

    onStage?.("app", "Starting the app at BASE and HEAD");
    servers.push(await startApp(recipe, baseWt));
    servers.push(await startApp(recipe, headWt));
    const [base, head] = servers;

    // Load each app once like a user would, for $0, before Bob's few script attempts depend on it.
    onStage?.("app", "Warming up both apps");
    for (const [label, server] of [["BASE", base], ["HEAD", head]] as const) {
      const { ms } = await warmUp(server.url, { readySelector: recipe.readySelector });
      console.log(`[verify] ${label} warmed up in ${Math.round(ms / 1000)}s`);
    }

    // A recovered session keeps what it wrote; a fresh one starts from a clean directory.
    if (!offline) await rm(verifyDir, { recursive: true, force: true });
    await mkdir(verifyDir, { recursive: true });
    await writeFile(
      path.join(verifyDir, "pw.cjs"),
      `// Written by the backend: Playwright from the walkthrough server, launch already verified.\n` +
        `const { chromium } = require(${JSON.stringify(PLAYWRIGHT)});\n` +
        `exports.chromium = chromium;\n` +
        `exports.launch = (opts = {}) => chromium.launch({ headless: true, ...opts });\n`
    );
    await mkdir(path.dirname(modePath), { recursive: true });
    await writeFile(modePath, modeYaml());
    await mkdir(runDir, { recursive: true });

    let taskId = recover?.taskId;
    if (reuseSaved) {
      const saved = path.join(ROOT, "data/verify", owner, repo, String(wt.pr.number));
      if (existsSync(path.join(saved, "scenarios.json"))) {
        for (const f of await readdir(saved)) {
          if (f.endsWith(".cjs") && f !== "pw.cjs") await copyFile(path.join(saved, f), path.join(verifyDir, f));
        }
        await copyFile(path.join(saved, "scenarios.json"), path.join(verifyDir, "scenarios.json"));
        outcomeNote = "re-rendered from saved scenarios (no Bob)";
      } else {
        // Nothing confirmed was ever saved (e.g. the session died after Bob wrote scripts): use whatever
        // scripts are still in the working directory.
        outcomeNote = "re-rendered from the scripts left in the working directory (no Bob)";
      }
      onStage?.("shots", "Re-rendering frames from the scenarios");
    } else if (!recover) {
      const prompt = buildPrompt(wt, recipe, base.url, head.url, opts.diff);
      await writeFile(path.join(runDir, "prompt.md"), prompt);
      await assertBudget(maxCost);
      onStage?.("shots", "Bob is reproducing the change and taking screenshots");
      firstRun = await runBobVerifier(prompt, headWt, maxCost, runDir, onEvent);
      costUsd = firstRun.sessionCost;
      taskId = firstRun.taskId;
      outcomeNote = "Bob finished; backend confirmation did not complete";
      if (firstRun.errorMessage && outOfCredits(firstRun.errorMessage)) {
        // Keep whatever Bob managed to write — it is still checked by the contract below — but say why
        // there may be nothing, instead of blaming the script.
        console.warn(`[verify] ${firstRun.errorMessage}`);
        outcomeNote = "Bob ran out of credits mid-run";
      }
    } else {
      onStage?.("shots", "Finishing the earlier screenshot session");
      outcomeNote = "recovered an earlier session; backend confirmation did not complete";
    }

    let skip: string | undefined;
    try {
      const skipJson = JSON.parse(await readFile(path.join(verifyDir, "skip.json"), "utf-8")) as { skip?: string };
      skip = typeof skipJson.skip === "string" ? skipJson.skip : "skip.json present but malformed";
    } catch {
      /* no skip.json — proceed to confirm repro.cjs */
    }
    if (skip) {
      outcomeNote = `skipped: ${skip}`;
      return { status: "skipped", reason: skip, costUsd, kind: "declined" };
    }

    // The scenarios' contract (ST12-C): each script must say true on BASE and false on HEAD and show
    // a visible difference. When some don't, ONE cheap resume with the real outputs for all of them
    // instead of throwing the paid run away — only with a task to resume and budget for it.
    const canRepair =
      !!taskId && repairMax > 0 && (await assertBudget(repairMax).then(() => true, () => false));
    const { results, repaired, flaky } = await confirmScenariosWithRepair(
      { verifyDir, baseUrl: base.url, headUrl: head.url, frameDir: outDir, logDir: runDir, fallbackTitle: wt.plain?.title },
      canRepair
        ? async (prompt) => {
            onStage?.("shots", "Some scenarios didn't hold up — asking Bob to fix them with the real results");
            repairSpentBefore = costUsd;
            const cap = Number((costUsd + repairMax).toFixed(2));
            repairRun = await runBobVerifier(prompt, headWt, cap, runDir, onEvent, taskId);
            costUsd = Math.max(costUsd, repairRun.sessionCost);
          }
        : undefined
    );
    const passing = results.filter((r) => r.outcome.ok);
    if (repaired) console.log(`[verify] repair resume ran; ${passing.length}/${results.length} scenario(s) confirmed`);

    if (passing.length === 0) {
      const creditsGone = !!(firstRun?.errorMessage && outOfCredits(firstRun.errorMessage));
      const why = creditsGone
        ? "the screenshot tool has no credits left"
        : results.map((r) => r.outcome.problem).filter(Boolean).join("; ") || "Bob did not write any scenario script";
      outcomeNote = why;
      return { status: "skipped", reason: why, costUsd };
    }

    // Confirmed. Persist the scripts FIRST — they are the evidence, and the ablation runner reuses them
    // verbatim at $0. Nothing after this point (frames, annotation) may lose them.
    const persistDir = path.join(ROOT, "data/verify", owner, repo, String(wt.pr.number));
    await mkdir(persistDir, { recursive: true });
    await copyFile(path.join(verifyDir, "pw.cjs"), path.join(persistDir, "pw.cjs"));
    for (const r of passing) await copyFile(path.join(verifyDir, r.scenario.file), path.join(persistDir, r.scenario.file));
    await writeFile(
      path.join(persistDir, "scenarios.json"),
      JSON.stringify(passing.map((r) => ({ id: r.scenario.id, file: r.scenario.file, title: r.scenario.title, ...(r.scenario.symptomIndex !== undefined ? { symptomIndex: r.scenario.symptomIndex } : {}) })), null, 2)
    );
    outcomeOk = true;
    outcomeNote = `${passing.length} scenario(s) confirmed true@BASE/false@HEAD${repaired ? " after one repair" : ""}${flaky.length ? ` (flaky on first check: ${flaky.join(", ")})` : ""}`;
    const dropped = results.length - passing.length;
    if (dropped > 0) outcomeNote += `; ${dropped} dropped: ${results.filter((r) => !r.outcome.ok).map((r) => r.scenario.id).join(", ")}`;

    // Main pair: the first scenario whose BASE and HEAD frames really differ. A pair that looks the same
    // reads as broken evidence — so if none differs, say so instead of showing one.
    const beforePng = path.join(outDir, "before.png");
    const afterPng = path.join(outDir, "after.png");
    // The widest (desktop) scenario shows the change in its whole context; a phone scenario is the main
    // pair only when nothing on desktop differs. Phone frames are also shown on the symptoms step.
    const dims = await Promise.all(
      passing.map(async (r) => (existsSync(r.beforePng) ? pngDimensions(await readFile(r.beforePng)) : null))
    );
    const widths = dims.map((d) => d?.width ?? 0);
    const mainIdx = pickMainIndex(passing.map((r, i) => ({ visible: r.visible, width: widths[i] })));
    const main = mainIdx >= 0 ? passing[mainIdx] : undefined;
    let shots: Shots | undefined;
    if (main) {
      await copyFile(main.beforePng, beforePng);
      await copyFile(main.afterPng, afterPng);
      const mb = main.outcome.before as { highlights?: unknown[] };
      const ma = main.outcome.after as { highlights?: unknown[] };
      const normalized = normalizeHighlights(mb.highlights ?? [], ma.highlights ?? []);
      // Aim at what actually changed between the two frames, not at the whole component Bob boxed.
      const region = changedRegion(await readFile(beforePng), await readFile(afterPng));
      // A box over most of the picture marks nothing (and its label would sit on top of everything).
      const notHuge = (h: { w: number; h: number }) => h.w * h.h <= MAX_BOX_AREA;
      const hl = {
        before: focusOnChange(normalized.before, region, { pad: 0.06 }).filter(notHuge),
        after: focusOnChange(normalized.after, region, { pad: 0.06 }).filter(notHuge),
      };
      const crop = maybeCropRegion(hl.before, hl.after);
      const beforeSrc = await annotateOrRaw(beforePng, path.join(outDir, "before-annotated.png"), hl.before, "bad", crop);
      const afterSrc = await annotateOrRaw(afterPng, path.join(outDir, "after-annotated.png"), hl.after, "good", crop);
      // On a phone frame nothing is drawn, so its labels become a plain caption under the picture.
      const phoneMain = !!dims[mainIdx] && isPhoneSize(dims[mainIdx]!.width, dims[mainIdx]!.height);
      const capOf = (h: typeof hl.before) => (phoneMain ? h.map((x) => x.label).filter(Boolean).join(" · ") || undefined : undefined);
      shots = {
        before: { src: beforeSrc, raw: "before.png", highlights: hl.before, ...(capOf(hl.before) ? { caption: capOf(hl.before) } : {}) },
        after: { src: afterSrc, raw: "after.png", highlights: hl.after, ...(capOf(hl.after) ? { caption: capOf(hl.after) } : {}) },
        ...(wt.plain?.title ? { caption: wt.plain.title.slice(0, 120) } : {}),
        by: "bob-verifier",
        run: { costUsd, durationMs: (firstRun?.ms ?? 0) + (repairRun?.ms ?? 0), toolCalls: (firstRun?.toolCalls ?? 0) + (repairRun?.toolCalls ?? 0) },
      };
    }
    const anyIdentical = passing.some((r) => r.identical);
    outcomeNote += main ? `, main pair from "${main.scenario.id}"` : anyIdentical ? ", frames identical — no pair" : ", scenarios wrote no frames";

    // Cards for the walkthrough's symptoms: each scenario tied to a symptom contributes its BASE frame,
    // cropped to what it highlights (the reader sees the problem, not a whole empty screen).
    let symptomSrcs: Map<number, string> | undefined;
    const wantsCards = listSymptomTexts(wt).length;
    for (const r of passing) {
      const idx = r.scenario.symptomIndex;
      if (idx === undefined || idx >= wantsCards || !existsSync(r.beforePng)) continue;
      try {
        // A card that just repeats the main "before" adds nothing (the scenario behind it is not the main one).
        if (main && r !== main && comparePngs(await readFile(r.beforePng), await readFile(main.beforePng))?.identical) continue;
        // With ONE scenario the start screen already shows its before/after pair; a card on the very next
        // screen would repeat that same picture (#21). Cards are for showing several problems side by side.
        if (main && r === main && passing.length === 1 && shots) continue;
        // Same idea for the card: zoom on what differs between this scenario's BASE and HEAD frames.
        const bRegion = existsSync(r.afterPng) ? changedRegion(await readFile(r.beforePng), await readFile(r.afterPng)) : null;
        const bh = focusOnChange(normalizeHighlights((r.outcome.before as { highlights?: unknown[] }).highlights ?? [], []).before, bRegion, { pad: 0.06 });
        const crop = maybeCropRegion(bh, []);
        const src = await annotateOrRaw(r.beforePng, path.join(outDir, `symptom-${idx}-annotated.png`), bh, "bad", { crop });
        (symptomSrcs ??= new Map()).set(idx, src);
      } catch (err) {
        console.warn(`[verify] symptom card ${idx} failed:`, err instanceof Error ? err.message : err);
      }
    }
    if (symptomSrcs) outcomeNote += `, ${symptomSrcs.size} symptom card(s)`;

    const first = passing[0].outcome;
    return {
      status: "ok",
      ...(shots ? { shots } : {}),
      ...(!shots ? { shotsNote: anyIdentical ? IDENTICAL_FRAMES_NOTE : NO_FRAMES_NOTE } : {}),
      costUsd,
      reproPath: path.join(persistDir, passing[0].scenario.file),
      ...(symptomSrcs ? { symptomSrcs } : {}),
      measures: { base: (first.before as { measure?: unknown }).measure, head: (first.after as { measure?: unknown }).measure },
      scenarios: passing.map((r) => ({ id: r.scenario.id, title: r.scenario.title, path: path.join(persistDir, r.scenario.file) })),
    };
  } catch (err) {
    // Whatever broke (install, dev server, warm-up, Bob's process, the filesystem) — report it
    // as a skip WITH the money already spent, instead of throwing it away with the exception.
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[verify] failed:", message);
    outcomeNote = `failed: ${message.slice(0, 200)}`;
    return { status: "skipped", reason: message, costUsd };
  } finally {
    if (firstRun) {
      await recordSpend({
        pr: wt.pr.repo + "#" + wt.pr.number,
        mode: "pr-verifier",
        maxCost,
        actualCost: firstRun.sessionCost,
        durationSec: Math.round(firstRun.ms / 1000),
        toolCalls: firstRun.toolCalls,
        subagents: 0,
        repairs: 0,
        valid: outcomeOk,
        notes: outcomeNote,
      });
    }
    if (repairRun) {
      // The resume reports the task's NEW cumulative cost; only the increment is new money.
      await recordSpend({
        pr: wt.pr.repo + "#" + wt.pr.number,
        mode: "pr-verifier-repair",
        maxCost: repairMax,
        actualCost: Math.max(0, repairRun.sessionCost - repairSpentBefore),
        durationSec: Math.round(repairRun.ms / 1000),
        toolCalls: repairRun.toolCalls,
        subagents: 0,
        repairs: 1,
        valid: outcomeOk,
        notes: outcomeNote,
      });
    }
    await Promise.all(servers.map((s) => s.stop()));
    if (previousMode !== undefined) await writeFile(modePath, previousMode).catch(() => {});
    else await rm(modePath, { force: true }).catch(() => {});
  }
}
