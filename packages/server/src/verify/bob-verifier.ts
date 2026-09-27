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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProgressStage, Shots, Walkthrough } from "@pr-walkthrough/shared";

import { assertBudget, recordSpend } from "../analyzer/budget.js";
import { summarizeEvents } from "../analyzer/bob-shell.js";
import { NdjsonBuffer } from "../analyzer/ndjson-buffer.js";
import { ensureWorktree } from "../git/workspace.js";
import { annotateShot } from "../shots/annotate.js";
import { ensureInstalled, scrubbedEnv, startApp, type AppServer } from "./app-servers.js";
import { normalizeHighlights, maybeCropRegion } from "./highlights.js";
import { recipeFor, type AppRecipe } from "./recipes.js";
import { runRepro } from "./ablation.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const MODE_SLUG = "pr-verifier";
const PLAYWRIGHT = createRequire(import.meta.url).resolve("playwright");

export interface VerifyOptions {
  walkthrough: Walkthrough;
  /** Where the final PNGs go, e.g. data/shots/{owner}/{repo}/{number}. */
  outDir: string;
  maxCost?: number;
  onStage?: (stage: ProgressStage, label: string) => void;
  /** Raw `bob run --format stream-json` events, for the progress screen. */
  onEvent?: (e: unknown) => void;
}

export type VerifyResult =
  | { status: "ok"; shots: Shots; costUsd: number; reproPath: string }
  | { status: "skipped"; reason: string; costUsd: number };

/** Does this repo have a way to start its app at all? (cheap pre-check, no side effects) */
export function canVerify(repoFullName: string): boolean {
  const [owner, repo] = repoFullName.split("/");
  return !!recipeFor(owner, repo);
}

function buildPrompt(wt: Walkthrough, recipe: AppRecipe, baseUrl: string, headUrl: string): string {
  const files = [...new Set(wt.hunks.map((h) => h.file))];
  const steps = wt.steps
    .filter((s) => !s.minor)
    .map((s) => `- ${s.headline ?? s.title}${s.say ? ` — ${s.say}` : ""}`)
    .join("\n");
  const scenario = (wt.verification?.scenario ?? []).map((l) => `- ${l}`).join("\n") || "(none)";
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

## App tips
${recipe.hints}

## Your job
1. Pick ONE short scenario (at most 6 UI actions) that makes the difference visible, and a concrete,
   measurable signal for "the bug is present" (an element's bounding box overflowing the viewport, a
   z-order via \`document.elementFromPoint\`, a class/attribute, visible text — not "it looks wrong").
   Start with a ${width}×${height} viewport; if the change is about small screens, overflow or layout
   limits, use the viewport where it shows (e.g. 390×844 phone) — the SAME viewport regardless of
   which url you're given. Read the changed source for reliable selectors — do not guess.
2. If the change has no such signal (performance, internal refactor, types, tests, build config), do
   not force it: write \`{"skip": "<one sentence why>"}\` to \`.walkthrough/verify/skip.json\`, print
   it, and stop — do not write repro.cjs.
3. Write ONE CommonJS script \`.walkthrough/verify/repro.cjs\`, run as \`node repro.cjs <url> [pngPath]\`
   (argv[2] = the app url to check, argv[3] = optional screenshot path). A tested Playwright helper is
   already there — use it, do not look for browsers or Playwright yourself:
   \`const { launch } = require("./pw.cjs"); const browser = await launch();\`
   The script must, for THAT ONE url:
   - open a page at your chosen viewport, go to the url, run the scenario (≤ 30 s per action);
   - measure your chosen signal and decide \`bugPresent\` (boolean) from it — not from which url string
     was passed in; the same logic must work no matter which build is actually running there;
   - if argv[3] is given, save a screenshot there, and also compute 1–3 highlight boxes (the element(s)
     that show the difference), as fractions of the viewport: \`{x,y,w,h,label,pair?}\`. A label should
     say what is wrong when \`bugPresent\` and what is fixed when not. Boxes marking the SAME spot get
     the same "pair" id (e.g. "sidebar") — the backend then draws them the same size on both images;
   - print EXACTLY ONE line of JSON and nothing else on your last line of output:
     \`{"bugPresent": true, "measure": {...whatever numbers you used...}, "highlights": [...]}\`
     (\`highlights\` can be \`[]\` when no pngPath was given, or when no clear box applies).
4. Test it yourself: run it against BOTH ${baseUrl} and ${headUrl}. It must print \`bugPresent: true\`
   for BASE and \`bugPresent: false\` for HEAD. If not, fix the script and retry — at most 3 runs of any
   script in total (probes included). Your budget is small: if you still can't get a reliable true/false
   split after that, write the skip file instead of continuing to explore.

## Rules
- Write files ONLY under \`.walkthrough/verify/\` — not \`/tmp\`, not anywhere else. Never edit the
  repository's source.
- Do not install packages. No network access except the two app URLs above.
- Final answer: print repro.cjs's own last JSON line from your BASE test run (or the skip JSON).
`;
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

async function runBobVerifier(
  prompt: string,
  workspace: string,
  maxCost: number,
  runDir: string,
  onEvent?: (e: unknown) => void
): Promise<{ events: unknown[]; ms: number } & ReturnType<typeof summarizeEvents>> {
  const args = [
    "run", "--format", "stream-json", "--mode", MODE_SLUG,
    "--workspace", workspace, "--max-cost", String(maxCost),
    "--max-turns", "40", "--disable-mcp", "--disable-subagents", "--trust", "--accept-license",
  ];
  const started = Date.now();
  const env = scrubbedEnv(process.env.BOB_API_KEY ? { BOB_API_KEY: process.env.BOB_API_KEY } : {});
  return new Promise((resolve, reject) => {
    const child = spawn("bob", args, { cwd: workspace, env, detached: true, timeout: 600_000 });
    let stdout = "";
    const live = new NdjsonBuffer();
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
      if (onEvent) for (const e of live.push(d.toString())) onEvent(e);
    });
    child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", async () => {
      // Anything Bob left running (a stray browser, a server it started anyway) goes with its group.
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      if (onEvent) for (const e of live.flush()) onEvent(e);
      await writeFile(path.join(runDir, "events.ndjson"), stdout).catch(() => {});
      const events = stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return l; }
      });
      resolve({ events, ms: Date.now() - started, ...summarizeEvents(events) });
    });
    child.stdin.end(prompt);
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


export async function verifyShots(opts: VerifyOptions): Promise<VerifyResult> {
  const { walkthrough: wt, outDir, onStage, onEvent } = opts;
  const maxCost = opts.maxCost ?? Number(process.env.VERIFY_MAX_COST ?? 2);
  const [owner, repo] = wt.pr.repo.split("/");
  const recipe = recipeFor(owner, repo);
  if (!recipe) return { status: "skipped", reason: `no app recipe for ${wt.pr.repo}`, costUsd: 0 };
  if (!wt.pr.baseSha || !wt.pr.headSha) return { status: "skipped", reason: "walkthrough has no base/head SHA", costUsd: 0 };

  const mainPath = path.join(GIT_CACHE_DIR, `${owner}__${repo}`);
  const baseWt = await ensureWorktree(mainPath, wt.pr.baseSha);
  const headWt = await ensureWorktree(mainPath, wt.pr.headSha);

  onStage?.("app", "Preparing the app at BASE and HEAD (reusing installed dependencies)");
  // Sequential on purpose: the second worktree can then clone the first one's install.
  const baseInstall = await ensureInstalled(recipe, baseWt);
  const headInstall = await ensureInstalled(recipe, headWt);
  console.log(`[verify] dependencies: BASE ${baseInstall}, HEAD ${headInstall}`);

  // Fail fast for $0 if the headless browser can't start (e.g. Playwright updated without
  // `playwright install`) — otherwise Bob burns its budget working around it.
  await assertBrowserWorks();

  const servers: AppServer[] = [];
  const modePath = path.join(headWt, ".bob", "custom_modes.yaml");
  const previousMode = existsSync(modePath) ? await readFile(modePath, "utf-8") : undefined;
  const verifyDir = path.join(headWt, ".walkthrough", "verify");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(ROOT, "data/runs", `${stamp}-${repo}-${wt.pr.number}-verify`);
  let costUsd = 0;

  try {
    onStage?.("app", "Starting the app at BASE and HEAD");
    servers.push(await startApp(recipe, baseWt));
    servers.push(await startApp(recipe, headWt));
    const [base, head] = servers;

    await rm(verifyDir, { recursive: true, force: true });
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
    const prompt = buildPrompt(wt, recipe, base.url, head.url);
    await writeFile(path.join(runDir, "prompt.md"), prompt);

    await assertBudget(maxCost);
    onStage?.("shots", "Bob is reproducing the change and taking screenshots");
    const run = await runBobVerifier(prompt, headWt, maxCost, runDir, onEvent);
    costUsd = run.sessionCost;

    let skip: string | undefined;
    try {
      const skipJson = JSON.parse(await readFile(path.join(verifyDir, "skip.json"), "utf-8")) as { skip?: string };
      skip = typeof skipJson.skip === "string" ? skipJson.skip : "skip.json present but malformed";
    } catch {
      /* no skip.json — proceed to confirm repro.cjs */
    }

    const reproPath = path.join(verifyDir, "repro.cjs");
    let confirmError: string | undefined;
    let beforeResult, afterResult;
    if (!skip) {
      if (!existsSync(reproPath)) {
        confirmError = run.errorMessage ?? "Bob did not write repro.cjs";
      } else {
        // The repro contract (ST12-C): don't trust Bob's own claim that the script
        // works — run it ourselves against BASE and HEAD and require the exact
        // signal the ablation runner will later rely on.
        [beforeResult, afterResult] = await Promise.all([
          runRepro(reproPath, base.url, verifyDir, path.join(outDir, "before.png")),
          runRepro(reproPath, head.url, verifyDir, path.join(outDir, "after.png")),
        ]);
        if ("error" in beforeResult) confirmError = `repro.cjs failed on BASE: ${beforeResult.error}`;
        else if ("error" in afterResult) confirmError = `repro.cjs failed on HEAD: ${afterResult.error}`;
        else if (!beforeResult.bugPresent) confirmError = "repro.cjs says the bug is already absent on BASE — not trusted";
        else if (afterResult.bugPresent) confirmError = "repro.cjs still says the bug is present on HEAD — not trusted";
      }
    }
    const ok = !skip && !confirmError;

    await recordSpend({
      pr: wt.pr.repo + "#" + wt.pr.number,
      mode: "pr-verifier",
      maxCost,
      actualCost: run.sessionCost,
      durationSec: Math.round(run.ms / 1000),
      toolCalls: run.toolCalls,
      subagents: 0,
      repairs: 0,
      valid: ok,
      notes: skip ? `skipped: ${skip}` : ok ? "repro confirmed true@BASE/false@HEAD, screenshots taken" : confirmError,
    });

    if (skip) return { status: "skipped", reason: skip, costUsd };
    if (!ok || !beforeResult || !afterResult || "error" in beforeResult || "error" in afterResult) {
      return { status: "skipped", reason: confirmError ?? "repro.cjs not confirmed", costUsd };
    }

    const hl = normalizeHighlights(beforeResult.highlights ?? [], afterResult.highlights ?? []);
    const crop = maybeCropRegion(hl.before, hl.after);
    await mkdir(outDir, { recursive: true });
    await annotateShot(path.join(outDir, "before.png"), path.join(outDir, "before-annotated.png"), hl.before, "bad", crop);
    await annotateShot(path.join(outDir, "after.png"), path.join(outDir, "after-annotated.png"), hl.after, "good", crop);

    // Persist the CONFIRMED script (not a throwaway build artifact — the ablation
    // runner reuses it verbatim, at $0, against disposable partial-patch checkouts).
    const persistDir = path.join(ROOT, "data/verify", owner, repo, String(wt.pr.number));
    await mkdir(persistDir, { recursive: true });
    await copyFile(reproPath, path.join(persistDir, "repro.cjs"));
    await copyFile(path.join(verifyDir, "pw.cjs"), path.join(persistDir, "pw.cjs"));

    const shots: Shots = {
      before: { src: "before-annotated.png", raw: "before.png", highlights: hl.before },
      after: { src: "after-annotated.png", raw: "after.png", highlights: hl.after },
      ...(wt.plain?.title ? { caption: wt.plain.title.slice(0, 120) } : {}),
      by: "bob-verifier",
      run: { costUsd: run.sessionCost, durationMs: run.ms, toolCalls: run.toolCalls },
    };
    return { status: "ok", shots, costUsd, reproPath: path.join(persistDir, "repro.cjs") };
  } finally {
    await Promise.all(servers.map((s) => s.stop()));
    if (previousMode !== undefined) await writeFile(modePath, previousMode).catch(() => {});
    else await rm(modePath, { force: true }).catch(() => {});
  }
}
