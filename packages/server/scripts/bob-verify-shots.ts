/**
 * bob-verify-shots.ts — run ONLY the Bob screenshot verifier (ST6e) on an
 * already-cached walkthrough, without a new analysis. Same code path as the
 * live pipeline (src/verify/bob-verifier.ts). Spends Bobcoins (budget-guarded,
 * logged to docs/cost-log-stage2.md).
 *
 *   pnpm --filter @pr-walkthrough/server bob:verify-shots excalidraw/excalidraw#10295
 *     → writes data/shots/{owner}/{repo}/{n}-bob-trial/, leaves the walkthrough alone
 *   … bob:verify-shots excalidraw/excalidraw#10295 --apply
 *     → writes data/shots/{owner}/{repo}/{n}/ and sets walkthrough.shots
 *
 * VERIFY_MAX_COST (default 2) caps the Bob run.
 */
import "../src/env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWalkthrough, saveWalkthrough } from "../src/storage.js";
import { verifyShots } from "../src/verify/bob-verifier.js";
import { runAblation, verdictForStep } from "../src/verify/ablation.js";
import { recipeFor } from "../src/verify/recipes.js";
import { prepareWorkspace } from "../src/git/workspace.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";

const spec = process.argv[2] ?? "";
const apply = process.argv.includes("--apply");
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(spec);
if (!m) throw new Error(`Usage: bob:verify-shots owner/repo#number [--apply] (got "${spec}")`);
const [, owner, repo, num] = m;

const wt = await loadWalkthrough(owner, repo, Number(num));
if (!wt) throw new Error(`No cached walkthrough for ${spec}`);

const outDir = path.join(ROOT, "data/shots", owner, repo, apply ? num : `${num}-bob-trial`);
console.log(`bob-verify-shots ${spec} → ${path.relative(ROOT, outDir)}${apply ? " (apply)" : " (trial)"}`);

const result = await verifyShots({
  walkthrough: wt,
  outDir,
  onStage: (stage, label) => console.log(`• [${stage}] ${label}`),
});

console.log(`cost $${result.costUsd.toFixed(3)}`);
if (result.status === "skipped") {
  console.log(`skipped: ${result.reason}`);
} else {
  console.log(JSON.stringify(result.shots, null, 2));
  if (apply) {
    wt.shots = result.shots;
    await saveWalkthrough(wt);
    console.log("walkthrough.shots updated");
  }

  // ST12-D, $0: only with --ablate, since it's several more app starts on top
  // of an already-paid verifier run.
  if (process.argv.includes("--ablate")) {
    const recipe = recipeFor(owner, repo);
    if (!recipe || !wt.pr.baseSha) {
      console.log("ablation skipped: no recipe or baseSha");
    } else {
      console.log("\nrunning ablation…");
      const workspace = await prepareWorkspace(`https://github.com/${owner}/${repo}`, wt.pr.headSha!, wt.pr.baseSha, wt.pr.number, GIT_CACHE_DIR);
      const diff = await workspace.diff();
      const ablation = await runAblation({
        mainPath: path.join(GIT_CACHE_DIR, `${owner}__${repo}`),
        baseSha: wt.pr.baseSha,
        diff,
        hunks: wt.hunks,
        skippedHunks: wt.skippedHunks,
        recipe,
        reproPath: result.reproPath,
        onProgress: (m) => console.log("  •", m),
      });
      console.log(JSON.stringify(ablation, null, 2));
      for (const step of wt.steps) {
        const verdict = verdictForStep(ablation, step.hunkIds);
        console.log(`  ${step.id}: ${verdict ?? "(no verdict)"}`);
        if (apply && verdict) step.evidence = { source: "ablation", verdict };
      }
      if (apply) {
        wt.verification = { ...wt.verification, status: "passed", scenario: wt.verification?.scenario ?? [], ablation };
        await saveWalkthrough(wt);
        console.log("walkthrough.verification.ablation + step.evidence saved");
      }
    }
  }
}
