/**
 * bob-revise.ts — CLI for ST12-E. Core logic lives in src/verify/revise.ts
 * (also used by the live analyze pipeline).
 *
 *   pnpm --filter @pr-walkthrough/server bob:revise excalidraw/excalidraw#10943 [--apply]
 */

import "../src/env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWalkthrough, saveWalkthrough } from "../src/storage.js";
import { prepareWorkspace, ensureWorktree } from "../src/git/workspace.js";
import { reviseFromAblation } from "../src/verify/revise.js";
import { runRepro } from "../src/verify/ablation.js";
import { resolveRecipe } from "../src/verify/recipes.js";
import { startApp } from "../src/verify/app-servers.js";
import type { Ablation } from "@pr-walkthrough/shared";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";

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
if (!ablation || ablation.runs.length === 0) {
  throw new Error(`${spec}: no verification.ablation — run bob:verify-shots ... --ablate first`);
}
if (!wt.pr.baseSha || !wt.pr.headSha) throw new Error(`${spec}: no base/head SHA`);

console.log(`bob-revise ${spec} — resuming task ${taskId.slice(0, 12)}…`);

const workspace = await prepareWorkspace(
  `https://github.com/${owner}/${repo}`,
  wt.pr.headSha,
  wt.pr.baseSha,
  number,
  GIT_CACHE_DIR
);
const diff = await workspace.diff();

const reproPath = path.join(ROOT, "data/verify", owner, repo, String(number), "repro.cjs");
let measures: { base: unknown; head: unknown } | undefined;
{
  const recipe = await resolveRecipe(owner, repo);
  if (recipe) {
    console.log("re-measuring BASE/HEAD with the confirmed repro script…");
    const mainPath = path.join(GIT_CACHE_DIR, `${owner}__${repo}`);
    const baseWt = await ensureWorktree(mainPath, wt.pr.baseSha);
    const headWt = await ensureWorktree(mainPath, wt.pr.headSha);
    const base = await startApp(recipe, baseWt);
    const head = await startApp(recipe, headWt);
    try {
      const [b, h] = await Promise.all([
        runRepro(reproPath, base.url, ROOT),
        runRepro(reproPath, head.url, ROOT),
      ]);
      measures = {
        base: "error" in b ? { error: b.error } : b.measure,
        head: "error" in h ? { error: h.error } : h.measure,
      };
    } finally {
      await base.stop();
      await head.stop();
    }
  }
}

const result = await reviseFromAblation({
  walkthrough: wt,
  ablation,
  repoPath: workspace.repoPath,
  diff,
  measures,
  force: true, // CLI always revises when invoked
  prLabel: spec,
});

if (result.status !== "ok") {
  console.error(`${result.status.toUpperCase()}: ${result.reason}`);
  process.exit(1);
}

console.log("VALID — diff of headline/say per step:");
for (const s of result.walkthrough.steps) {
  const before = wt.steps.find((o) => o.id === s.id);
  if (!before || before.headline !== s.headline || before.say !== s.say || before.minor !== s.minor) {
    console.log(
      `  ${s.id}: minor ${before?.minor ?? "?"}→${s.minor ?? false} | "${before?.headline ?? "(new)"}" → "${s.headline}"`
    );
  }
}

if (apply) {
  await saveWalkthrough(result.walkthrough);
  console.log(`saved ${spec} (revise cost $${result.costUsd.toFixed(3)})`);
} else {
  console.log(`\n--apply not given: not saved (revise cost $${result.costUsd.toFixed(3)})`);
}
