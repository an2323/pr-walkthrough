/**
 * bob-verify-shots.ts — ST6e capability spike (standalone, not wired into analyze).
 *
 * One paid Bob Shell run in custom mode `pr-verifier` (read + edit + execute):
 * start Excalidraw at BASE and HEAD, reproduce the #10295 scenario, write raw
 * screenshots + highlight JSON into a sandbox folder. Demo `10295/` shots are
 * never touched.
 *
 *   pnpm --filter @pr-walkthrough/server bob:verify-shots
 *
 * Env: BOB_API_KEY, optional GIT_CACHE_DIR, MAX_COST (default 5).
 */
import "../src/env.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ShotHighlight, ShotSide } from "@pr-walkthrough/shared";
import { loadWalkthrough } from "../src/storage.js";
import { annotateShot } from "../src/shots/annotate.js";
import { assertBudget, recordSpend } from "../src/analyzer/budget.js";
import { extractJsonObject } from "../src/analyzer/bob-shell.js";
import { NdjsonBuffer } from "../src/analyzer/ndjson-buffer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const MODE_SLUG = "pr-verifier";
const MAX_COST = Number(process.env.MAX_COST ?? 5);
const OWNER = "excalidraw";
const REPO = "excalidraw";
const NUMBER = 10295;
const BASE_PORT = 3020;
const HEAD_PORT = 3021;

const wt = await loadWalkthrough(OWNER, REPO, NUMBER);
if (!wt?.pr.baseSha || !wt.pr.headSha) {
  throw new Error(`No cached walkthrough / SHAs for ${OWNER}/${REPO}#${NUMBER}`);
}

const cacheRepo = path.join(GIT_CACHE, `${OWNER}__${REPO}`);
const baseWt = path.join(cacheRepo, "wt", wt.pr.baseSha);
const headWt = path.join(cacheRepo, "wt", wt.pr.headSha);
if (!existsSync(path.join(baseWt, "package.json")) || !existsSync(path.join(headWt, "package.json"))) {
  throw new Error(`Missing worktrees under ${cacheRepo}/wt — need BASE ${wt.pr.baseSha.slice(0, 7)} and HEAD ${wt.pr.headSha.slice(0, 7)}`);
}

const trialDir = path.join(ROOT, "data/shots", OWNER, REPO, `${NUMBER}-bob-trial`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(ROOT, "data/runs", `bob-verify-${stamp}`);
await mkdir(trialDir, { recursive: true });
await mkdir(runDir, { recursive: true });

const recipePath = path.join(ROOT, "data/shots", OWNER, REPO, String(NUMBER), "RECIPE.md");
const recipe = existsSync(recipePath) ? await readFile(recipePath, "utf8") : "(no RECIPE.md)";
const scenarios = wt.verification?.scenario ?? [];

// Custom mode on THIS workspace (the walkthrough monorepo) so Bob can write trial PNGs here.
await mkdir(path.join(ROOT, ".bob"), { recursive: true });
await writeFile(
  path.join(ROOT, ".bob", "custom_modes.yaml"),
  [
    "customModes:",
    `  - slug: ${MODE_SLUG}`,
    "    name: PR Verifier (screenshots)",
    "    roleDefinition: >-",
    "      You start local apps, drive the browser, and capture before/after screenshots",
    "      with highlight boxes for a pull-request walkthrough. You may edit files only",
    "      under the allowed output directory and temporary scripts you create.",
    "    whenToUse: Capturing BASE/HEAD screenshots for a known PR scenario.",
    "    groups:",
    "      - read",
    "      - edit",
    "      - execute",
    "",
  ].join("\n")
);

const prompt = `You are verifying a known Excalidraw PR by taking before/after screenshots.

## Absolute paths (use these exactly)
- BASE worktree (bug present): ${baseWt}
- HEAD worktree (fix): ${headWt}
- Output directory (ONLY place you may write PNGs / JSON): ${trialDir}
- Playwright is available via: cd ${path.join(ROOT, "packages/server")} && npx playwright …

## Ports
- BASE app: http://127.0.0.1:${BASE_PORT}
- HEAD app: http://127.0.0.1:${HEAD_PORT}

## How to start each app (Excalidraw)
If node_modules is missing, run \`yarn install\` in that worktree first.
Then:
  VITE_APP_PORT=<port> yarn --cwd excalidraw-app vite --host 127.0.0.1 --port <port> --strictPort
Wait until HTTP 200 on that port before continuing.

## Scenario (same as the demo)
${recipe}

Walkthrough scenario lines:
${scenarios.map((s) => `- ${s}`).join("\n") || "(none)"}

UI steps for each build:
1. Open the app URL, dismiss any \`.excalidraw-modal-container\`.
2. Click \`label[title="Library"]\`.
3. If \`button.sidebar__dock.selected\` exists, click it to undock the sidebar.
4. Click \`button.main-menu-trigger\`.
5. Screenshot viewport 1280×800 as a PNG.

## What to write
1. \`${trialDir}/before.png\` — BASE after the scenario (sidebar still open with menu).
2. \`${trialDir}/after.png\` — HEAD after the scenario (sidebar closed, menu open).
3. \`${trialDir}/result.json\` with this exact shape (highlights are fractions 0..1 of the image):
\`\`\`json
{
  "caption": "Open the library sidebar, then open the main menu.",
  "before": {
    "src": "before.png",
    "highlights": [
      { "x": 0, "y": 0, "w": 0, "h": 0, "label": "Main menu opened" },
      { "x": 0, "y": 0, "w": 0, "h": 0, "label": "Sidebar is still open" }
    ]
  },
  "after": {
    "src": "after.png",
    "highlights": [
      { "x": 0, "y": 0, "w": 0, "h": 0, "label": "Main menu opened" },
      { "x": 0, "y": 0, "w": 0, "h": 0, "label": "Sidebar closed by itself" }
    ]
  }
}
\`\`\`
Measure highlight boxes from DOM getBoundingClientRect (as fractions of the viewport). Prefer real measurements over guesses.

## Cleanup (required)
Kill both Vite processes and free ports ${BASE_PORT} and ${HEAD_PORT} before you finish.

## Final answer
When done, print ONLY the result.json object (no markdown fence, no extra prose). If you fail, still print a JSON object \`{ "error": "…" }\` and clean up servers.
`;

await writeFile(path.join(runDir, "prompt.txt"), prompt);

const spent = await assertBudget(MAX_COST);
console.log(`bob-verify-shots ${OWNER}/${REPO}#${NUMBER}`);
console.log(`  budget spent $${spent.toFixed(2)} + max $${MAX_COST} (cap $20)`);
console.log(`  trial → ${trialDir}`);
console.log(`  run   → ${runDir}`);

type BobRunSummary = {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  events: unknown[];
  taskId?: string;
  sessionCost: number;
  toolCalls: number;
  subagents: number;
  errorMessage?: string;
};

function summarizeEvents(events: unknown[]): Pick<BobRunSummary, "taskId" | "sessionCost" | "toolCalls" | "subagents" | "errorMessage"> {
  let taskId: string | undefined;
  let sessionCost = 0;
  let toolCalls = 0;
  let subagents = 0;
  let errorMessage: string | undefined;
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o["task_id"] === "string") taskId = o["task_id"] as string;
    if (typeof o["taskId"] === "string") taskId = o["taskId"] as string;
    const stats = o["stats"];
    if (stats && typeof stats === "object") {
      const s = stats as Record<string, unknown>;
      if (typeof s["session_costs"] === "number") sessionCost = s["session_costs"] as number;
      if (typeof s["task_id"] === "string") taskId = s["task_id"] as string;
    }
    if (o["type"] === "tool_use" || o["type"] === "tool_call") toolCalls++;
    if (o["tool_name"] === "spawn_subagent" || o["name"] === "spawn_subagent") subagents++;
    if (o["type"] === "error" && typeof o["message"] === "string") errorMessage = o["message"] as string;
    for (const val of Object.values(o)) {
      if (val && typeof val === "object") visit(val);
    }
  };
  events.forEach(visit);
  return { taskId, sessionCost, toolCalls, subagents, errorMessage };
}

function runBobVerifier(promptText: string, workspace: string, maxCost: string): Promise<BobRunSummary> {
  const args = [
    "run",
    "--format", "stream-json",
    "--mode", MODE_SLUG,
    "--workspace", workspace,
    "--max-cost", maxCost,
    "--max-turns", process.env.MAX_TURNS ?? "50",
    "--disable-mcp",
    "--trust",
    "--accept-license",
  ];
  console.log(`[bob-verify] $ bob ${args.join(" ")}`);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("bob", args, { cwd: workspace, env: process.env, timeout: 600_000 });
    let stdout = "";
    let stderr = "";
    const live = new NdjsonBuffer();
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
      for (const e of live.push(d.toString())) {
        const t = (e as { type?: string })?.type;
        if (t === "tool_use" || t === "assistant" || t === "error" || t === "result") {
          const brief = JSON.stringify(e).slice(0, 200);
          console.log(`[event] ${brief}`);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      for (const e of live.flush()) { /* drain */ }
      const events = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return line;
          }
        });
      resolve({ code, stdout, stderr, ms: Date.now() - started, events, ...summarizeEvents(events) });
    });
    child.stdin.end(promptText);
  });
}

const run = await runBobVerifier(prompt, ROOT, String(MAX_COST));
await writeFile(path.join(runDir, "stdout.ndjson"), run.stdout);
await writeFile(path.join(runDir, "stderr.txt"), run.stderr);
await writeFile(path.join(runDir, "summary.json"), JSON.stringify({
  code: run.code,
  ms: run.ms,
  taskId: run.taskId,
  sessionCost: run.sessionCost,
  toolCalls: run.toolCalls,
  subagents: run.subagents,
  errorMessage: run.errorMessage,
}, null, 2));

const files = existsSync(trialDir) ? await readdir(trialDir) : [];
const hasBefore = files.includes("before.png");
const hasAfter = files.includes("after.png");
const hasResult = files.includes("result.json");

let resultJson: unknown;
if (hasResult) {
  resultJson = JSON.parse(await readFile(path.join(trialDir, "result.json"), "utf8"));
} else {
  resultJson = extractJsonObject(run.stdout, (v) => {
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    return "before" in o || "error" in o;
  });
  if (resultJson) {
    await writeFile(path.join(trialDir, "result.json"), JSON.stringify(resultJson, null, 2));
  }
}

type ResultShape = {
  caption?: string;
  before?: ShotSide & { src: string; highlights?: ShotHighlight[] };
  after?: ShotSide & { src: string; highlights?: ShotHighlight[] };
  error?: string;
};

const parsed = (resultJson ?? {}) as ResultShape;
let annotated = false;
if (hasBefore && parsed.before?.highlights?.length) {
  await annotateShot(
    path.join(trialDir, "before.png"),
    path.join(trialDir, "before-annotated.png"),
    parsed.before.highlights,
    "bad"
  );
  annotated = true;
}
if (hasAfter && parsed.after?.highlights?.length) {
  await annotateShot(
    path.join(trialDir, "after.png"),
    path.join(trialDir, "after-annotated.png"),
    parsed.after.highlights,
    "good"
  );
  annotated = true;
}

const success = hasBefore && hasAfter && !parsed.error;
await recordSpend({
  pr: `${OWNER}/${REPO}#${NUMBER}`,
  mode: "pr-verifier",
  maxCost: MAX_COST,
  actualCost: run.sessionCost,
  durationSec: Math.round(run.ms / 1000),
  toolCalls: run.toolCalls,
  subagents: run.subagents,
  repairs: 0,
  valid: success,
  notes: [
    success ? "PNGs written to 10295-bob-trial" : "incomplete",
    hasBefore ? "before.png" : "no-before",
    hasAfter ? "after.png" : "no-after",
    hasResult || resultJson ? "result.json" : "no-result",
    annotated ? "annotated" : "no-annotate",
    run.errorMessage ? `err:${run.errorMessage.slice(0, 80)}` : "",
    parsed.error ? `bob:${parsed.error.slice(0, 80)}` : "",
  ].filter(Boolean).join("; "),
});

await writeFile(
  path.join(trialDir, "CAPABILITY.md"),
  `# Bob verifier spike — ${OWNER}/${REPO}#${NUMBER}

Date: ${new Date().toISOString()}
Cost: $${run.sessionCost.toFixed(3)} (max $${MAX_COST})
Duration: ${Math.round(run.ms / 1000)}s
Task: ${run.taskId ?? "(none)"}
Raw run: \`${path.relative(ROOT, runDir)}\`

## What Bob produced
- before.png: ${hasBefore ? "yes" : "NO"}
- after.png: ${hasAfter ? "yes" : "NO"}
- result.json: ${hasResult || resultJson ? "yes" : "NO"}
- annotated via our annotateShot: ${annotated ? "yes" : "no"}
- Bob error field: ${parsed.error ?? "(none)"}
- Process error: ${run.errorMessage ?? "(none)"}

## Demo assets
Hand-tuned screenshots under \`data/shots/.../10295/\` were **not** modified by this spike.

## Railway / “any PR”
This spike only tests Excalidraw #10295 with an explicit RECIPE and known worktrees.
It does **not** prove paste-any-PR: that still needs per-ecosystem start recipes, allowlists, and cost guards.
`,
  "utf8"
);

console.log("---");
console.log(`cost $${run.sessionCost.toFixed(3)} in ${Math.round(run.ms / 1000)}s`);
console.log(`before=${hasBefore} after=${hasAfter} result=${!!(hasResult || resultJson)} annotated=${annotated}`);
console.log(`trial files: ${files.join(", ") || "(empty)"}`);
if (!success) process.exitCode = 1;
