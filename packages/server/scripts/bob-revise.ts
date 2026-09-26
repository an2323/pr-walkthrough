/**
 * bob-revise.ts — ST12-E: resume the ORIGINAL analysis session and ask Bob to
 * rewrite only the steps its own ablation table (ST12-D) contradicts.
 *
 *   pnpm --filter @pr-walkthrough/server bob:revise excalidraw/excalidraw#10943 [--apply]
 *
 * Requires the cached walkthrough to already have `meta.run.taskId` (a real
 * `full`/live analysis, not a manual/cached one) and
 * `verification.ablation` (run `bob:verify-shots ... --ablate` first).
 * Re-runs the confirmed repro.cjs against BASE/HEAD itself (cheap, no Bob)
 * to hand Bob the exact measured facts alongside the ablation table — never
 * our own opinion about what's wrong, only what was measured.
 *
 * On success: re-validates like the main pipeline, keeps the existing
 * `shots`/`verification.ablation` and re-derives `step.evidence` for the
 * (possibly restructured) new steps, and only saves if that all passes.
 * On failure: prints why and leaves the previously-promoted JSON untouched —
 * never overwrites a good result with a broken one.
 */
import "../src/env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile as fsReadFile } from "node:fs/promises";

import type { AnalyzerInput } from "../src/analyzer/interface.js";
import type { RepoWorkspace } from "../src/git/workspace.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadWalkthrough, saveWalkthrough } from "../src/storage.js";
import { prepareWorkspace } from "../src/git/workspace.js";
import { runBob, findWalkthroughInEvents, normalizeDraft } from "../src/analyzer/bob-shell.js";
import { validate } from "../src/validation/index.js";
import { assertBudget, recordSpend } from "../src/analyzer/budget.js";
import { verdictForStep, runRepro } from "../src/verify/ablation.js";
import { recipeFor } from "../src/verify/recipes.js";
import { startApp } from "../src/verify/app-servers.js";
import { ensureWorktree } from "../src/git/workspace.js";
import type { Ablation, Walkthrough } from "@pr-walkthrough/shared";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const REVISE_MAX_COST = Number(process.env.REVISE_MAX_COST ?? 1);

const spec = process.argv[2] ?? "";
const apply = process.argv.includes("--apply");
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(spec);
if (!m) throw new Error(`Usage: bob:revise owner/repo#number [--apply] (got "${spec}")`);
const [, owner, repo, numStr] = m;
const number = parseInt(numStr, 10);

const wt = await loadWalkthrough(owner, repo, number);
if (!wt) throw new Error(`No cached walkthrough for ${spec}`);
const taskId = wt.meta.run?.taskId;
if (!taskId) throw new Error(`${spec}: no meta.run.taskId — this wasn't a live Bob analysis, nothing to resume`);
const ablation: Ablation | undefined = wt.verification?.ablation;
if (!ablation || ablation.runs.length === 0) throw new Error(`${spec}: no verification.ablation — run bob:verify-shots ... --ablate first`);
if (!wt.pr.baseSha || !wt.pr.headSha) throw new Error(`${spec}: no base/head SHA`);

console.log(`bob-revise ${spec} — resuming task ${taskId.slice(0, 12)}…`);

const workspace = await prepareWorkspace(`https://github.com/${owner}/${repo}`, wt.pr.headSha, wt.pr.baseSha, number, GIT_CACHE_DIR);
const diff = await workspace.diff();

// Re-measure BASE/HEAD ourselves with the CONFIRMED repro script — handed to
// Bob as fact, not read from the walkthrough's own (possibly wrong) prose.
const reproPath = path.join(ROOT, "data/verify", owner, repo, String(number), "repro.cjs");
let measures: { base: unknown; head: unknown } | undefined;
{
  const recipe = recipeFor(owner, repo);
  if (recipe) {
    console.log("re-measuring BASE/HEAD with the confirmed repro script…");
    const mainPath = path.join(GIT_CACHE_DIR, `${owner}__${repo}`);
    const baseWt = await ensureWorktree(mainPath, wt.pr.baseSha);
    const headWt = await ensureWorktree(mainPath, wt.pr.headSha);
    const base = await startApp(recipe, baseWt);
    const head = await startApp(recipe, headWt);
    try {
      const [b, h] = await Promise.all([runRepro(reproPath, base.url, ROOT), runRepro(reproPath, head.url, ROOT)]);
      measures = { base: "error" in b ? { error: b.error } : b.measure, head: "error" in h ? { error: h.error } : h.measure };
    } finally {
      await base.stop();
      await head.stop();
    }
  }
}

function formatAblation(a: Ablation): string {
  const lines = a.runs.map((r) => `- ${r.mode === "alone" ? "ONLY" : "EVERYTHING EXCEPT"} [${r.unitIds.join(", ")}] → ${r.verdict}${r.detail ? ` (${r.detail.slice(0, 120)})` : ""}`);
  return `Hunks tested: ${a.units.join(", ")}\n${lines.join("\n")}`;
}

const stepClaims = wt.steps
  .filter((s) => !s.minor)
  .map((s) => `${s.id} [hunks: ${s.hunkIds.join(", ") || "none"}]: "${s.headline ?? s.title}" — ${s.say ?? ""}`)
  .join("\n");

const prompt = `Evidence-based correction. Your walkthrough's steps make causal claims about which code
changes fix the bug. The backend has MEASURED which of the PR's hunks the fix actually needs, by
re-running your own repro script (from the verifier) against the real running app with different
subsets of the diff applied to BASE. This is measured fact from a running program, not a reading of
the source — it overrides your own reasoning wherever the two disagree.

## Ablation table (hunk id → does the bug script report the bug present or fixed with only/all-but that
hunk applied to BASE)
${formatAblation(ablation)}

## What "fixed"/"bug"/"broken" mean here
"fixed": the repro script's own bugPresent signal is false with this subset applied to BASE.
"bug": bugPresent is still true.
"broken": the app didn't build/start/respond with this subset — itself a finding (a dependency between
changes), not proof either way.

## Raw measurement at BASE and HEAD (the exact same repro script, unmodified)
BASE: ${JSON.stringify(measures?.base)}
HEAD: ${JSON.stringify(measures?.head)}

## Your current steps and their claims
${stepClaims}

## Your job
Rewrite ONLY the steps whose claims the table above contradicts:
- A step whose sole hunk is "needed" (removing it alone brings the bug back) must not be \`minor\` and
  should say plainly that this change is required, not incidental.
- A step whose sole hunk "fixes-alone" is validated — keep or strengthen its claim that this change is
  sufficient.
- A step whose sole hunk shows "no-effect" cannot be the one causing or fixing the measured bug by
  itself — rewrite its claim to match (e.g. "cleanup", "not required for this fix"), don't imply it was
  necessary unless a DIFFERENT reason (not this signal) justifies it, and say so.
- Never state a mechanism the measurement doesn't support (e.g. don't claim a specific DOM size like
  "0×0" unless it's in the measurement above). Where the evidence is silent (a step's hunk isn't in the
  table, or the viewport/scenario tested doesn't cover what the step claims — e.g. a mobile-only claim
  tested only at desktop width), leave the step tagged "inferred" and say in \`notes\` that it is
  untested by this measurement — do not guess a verdict for it.
Leave every step the evidence does NOT contradict exactly as it is.

Return the COMPLETE corrected JSON object again — same rules as the original analysis: no prose, no
markdown fence, omit hunks/coverage/pr.`;

const previousCost = wt.meta.run?.costUsd ?? 0;
const cumulativeCap = (previousCost + REVISE_MAX_COST).toFixed(2);
await assertBudget(REVISE_MAX_COST);
console.log(`spend so far $${previousCost.toFixed(3)} + revise allowance $${REVISE_MAX_COST} (cumulative cap $${cumulativeCap})`);

const run = await runBob(prompt, workspace.repoPath, cumulativeCap, { resumeTaskId: taskId });
console.log(`revise run: ${Math.round(run.ms / 1000)}s, cumulative cost $${run.sessionCost.toFixed(3)}, exit=${run.code}${run.errorMessage ? `, error: ${run.errorMessage}` : ""}`);
const increment = Math.max(0, run.sessionCost - previousCost);

const draftRaw = findWalkthroughInEvents(run.events);
if (!draftRaw) {
  await recordSpend({ pr: spec, mode: "revise", maxCost: REVISE_MAX_COST, actualCost: increment, durationSec: Math.round(run.ms / 1000), toolCalls: run.toolCalls, subagents: run.subagents, repairs: 0, valid: false, notes: "no JSON found in response" });
  throw new Error("no walkthrough JSON found in Bob's response — not saved");
}
normalizeDraft(draftRaw);
const full = { ...draftRaw, pr: wt.pr } as unknown as Walkthrough;

const ws: RepoWorkspace = {
  repoPath: workspace.repoPath,
  baseSha: wt.pr.baseSha,
  headSha: wt.pr.headSha,
  readFile: (file, rev) => (rev === "base" ? execFileAsync("git", ["show", `${wt.pr.baseSha}:${file}`], { cwd: workspace.repoPath, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout) : fsReadFile(path.join(workspace.repoPath, file), "utf-8")),
  diff: async () => diff,
};
const input: AnalyzerInput = { repoPath: workspace.repoPath, baseSha: wt.pr.baseSha, headSha: wt.pr.headSha, pr: wt.pr, hunks: wt.hunks, diff };
const result = await validate(full, input, ws);

await recordSpend({
  pr: spec, mode: "revise", maxCost: REVISE_MAX_COST, actualCost: increment,
  durationSec: Math.round(run.ms / 1000), toolCalls: run.toolCalls, subagents: run.subagents, repairs: 0,
  valid: result.valid, notes: result.valid ? "revised from ablation evidence" : result.errors.slice(0, 3).join("; "),
});

if (!result.valid || !result.walkthrough) {
  console.error(`INVALID — not saved. Errors:\n${result.errors.slice(0, 20).join("\n")}`);
  process.exit(1);
}

// Shots and the ablation table itself are untouched by a text revision — carry
// them over, then re-derive each step's evidence for the (possibly reordered
// or renumbered) new step set.
result.walkthrough.shots = wt.shots;
result.walkthrough.verification = wt.verification;
for (const step of result.walkthrough.steps) {
  const verdict = verdictForStep(ablation, step.hunkIds);
  if (verdict) step.evidence = { source: "ablation", verdict };
}
result.walkthrough.meta.run = {
  costUsd: run.sessionCost,
  maxCostUsd: Number(cumulativeCap),
  durationMs: (wt.meta.run?.durationMs ?? 0) + run.ms,
  toolCalls: (wt.meta.run?.toolCalls ?? 0) + run.toolCalls,
  subagents: (wt.meta.run?.subagents ?? 0) + run.subagents,
  repairs: (wt.meta.run?.repairs ?? 0) + 1,
  taskId,
};

console.log("VALID — diff of headline/say per step:");
for (const s of result.walkthrough.steps) {
  const before = wt.steps.find((o) => o.id === s.id);
  if (!before || before.headline !== s.headline || before.say !== s.say || before.minor !== s.minor) {
    console.log(`  ${s.id}: minor ${before?.minor ?? "?"}→${s.minor ?? false} | "${before?.headline ?? "(new)"}" → "${s.headline}"`);
  }
}

if (apply) {
  await saveWalkthrough(result.walkthrough);
  console.log(`saved ${spec}`);
} else {
  console.log("\n--apply not given: not saved");
}
