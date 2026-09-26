/**
 * bob-verifier.ts — ST6e: Bob reproduces a PR's user-visible change in the
 * running app and takes one screenshot at BASE and one at HEAD, with the
 * spot to look at boxed.
 *
 * Division of labour:
 *  - The backend installs and starts the app at BASE and HEAD (recipes.ts,
 *    app-servers.ts) and always stops it again — Bob never manages servers.
 *  - Bob (custom mode `pr-verifier`: read + edit + execute) reads the
 *    walkthrough and the changed source, decides the scenario, writes and runs
 *    a Playwright script, and returns screenshots + highlight boxes. It may
 *    decline ("skip") when the change isn't visible in a screenshot.
 *  - The backend validates the result, pairs the boxes (highlights.ts), draws
 *    them into the images and sets `walkthrough.shots`.
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
import { normalizeHighlights } from "./highlights.js";
import { recipeFor, type AppRecipe } from "./recipes.js";

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
  | { status: "ok"; shots: Shots; costUsd: number }
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
  return `You are checking a pull request by reproducing its user-visible change in the running app,
taking one screenshot BEFORE the PR (BASE) and one AFTER it (HEAD), with the spot to look at boxed.

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
1. Pick ONE short scenario (at most 6 UI actions) that makes the difference visible. Start with a
   ${width}×${height} viewport; if the change is about small screens, overflow or layout limits, use
   the viewport where it shows (e.g. 390×844 phone, or a shorter window) — same viewport for BASE
   and HEAD. Read the changed source to find reliable selectors — do not guess.
2. If the change is not visible in a screenshot (performance, internal refactor, types, tests,
   build config), do not force it: write \`{"skip": "<one sentence why>"}\` to
   \`.walkthrough/verify/result.json\`, print it and stop.
3. Write ONE CommonJS Playwright script \`.walkthrough/verify/shoot.cjs\`. A tested helper is
   already there — use it, do not look for browsers or Playwright yourself:
   \`const { launch } = require("./pw.cjs"); const browser = await launch();\`
   For BASE and then HEAD: open a page with your viewport, go to the URL, run the scenario (≤ 30 s per
   action), save the full viewport to \`.walkthrough/verify/before.png\` / \`after.png\`, and measure
   \`getBoundingClientRect()\` of the 1–3 elements that show the difference, as fractions of the
   viewport. Also assert in the script that the problem is present on BASE and gone on HEAD
   (visibility, \`document.elementFromPoint\` for stacking, text) and print what you found.
4. Run it: \`node .walkthrough/verify/shoot.cjs\`. If it fails or the assertions don't show the
   difference, fix it and retry — at most 3 runs of any script in total (probes included). Your
   budget is small: if the difference still isn't visible after that, write a skip result saying
   what you tried instead of exploring further.
5. Write \`.walkthrough/verify/result.json\`:
   {"caption": "<what you did, plain words, ≤ 12 words>", "viewport": {"width": 0, "height": 0},
    "before": {"file": "before.png", "highlights": [{"x":0,"y":0,"w":0,"h":0,"label":"…","pair":"…"}]},
    "after":  {"file": "after.png",  "highlights": [ … ]}}
   - 1–3 boxes per side, fractions 0..1 of the image. Labels: plain words, ≤ 5 words, no code names.
     BEFORE labels say what is wrong, AFTER labels say what is fixed.
   - Boxes marking the SAME spot on both sides (same element or area) get the same "pair" id
     (e.g. "sidebar"); the backend then draws them the same size.

## Rules
- Write files ONLY under \`.walkthrough/verify/\` — not \`/tmp\`, not anywhere else. Never edit the
  repository's source.
- Do not install packages. No network access except the two app URLs above.
- Final answer: print the content of result.json only.
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

/** Resolve a file Bob named, refusing anything outside the verify dir. */
function insideDir(dir: string, name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const p = path.resolve(dir, name);
  return p.startsWith(dir + path.sep) && p.endsWith(".png") && existsSync(p) ? p : undefined;
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

    let result: Record<string, unknown> | undefined;
    try {
      result = JSON.parse(await readFile(path.join(verifyDir, "result.json"), "utf-8"));
    } catch {
      /* handled below */
    }
    const skip = typeof result?.skip === "string" ? result.skip : undefined;
    const beforeRaw = insideDir(verifyDir, (result?.before as Record<string, unknown> | undefined)?.file);
    const afterRaw = insideDir(verifyDir, (result?.after as Record<string, unknown> | undefined)?.file);
    const ok = !skip && !!beforeRaw && !!afterRaw;

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
      notes: skip ? `skipped: ${skip}` : ok ? "screenshots taken" : run.errorMessage ?? "no usable result.json",
    });

    if (skip) return { status: "skipped", reason: skip, costUsd };
    if (!ok) return { status: "skipped", reason: run.errorMessage ?? "Bob returned no usable screenshots", costUsd };

    const before = result!.before as Record<string, unknown>;
    const after = result!.after as Record<string, unknown>;
    const hl = normalizeHighlights(
      Array.isArray(before.highlights) ? before.highlights : [],
      Array.isArray(after.highlights) ? after.highlights : []
    );
    await mkdir(outDir, { recursive: true });
    await copyFile(beforeRaw!, path.join(outDir, "before.png"));
    await copyFile(afterRaw!, path.join(outDir, "after.png"));
    await annotateShot(path.join(outDir, "before.png"), path.join(outDir, "before-annotated.png"), hl.before, "bad");
    await annotateShot(path.join(outDir, "after.png"), path.join(outDir, "after-annotated.png"), hl.after, "good");

    const caption = typeof result!.caption === "string" ? result!.caption.slice(0, 120) : undefined;
    const shots: Shots = {
      before: { src: "before-annotated.png", raw: "before.png", highlights: hl.before },
      after: { src: "after-annotated.png", raw: "after.png", highlights: hl.after },
      ...(caption ? { caption } : {}),
      by: "bob-verifier",
      run: { costUsd: run.sessionCost, durationMs: run.ms, toolCalls: run.toolCalls },
    };
    return { status: "ok", shots, costUsd };
  } finally {
    await Promise.all(servers.map((s) => s.stop()));
    if (previousMode !== undefined) await writeFile(modePath, previousMode).catch(() => {});
    else await rm(modePath, { force: true }).catch(() => {});
  }
}
