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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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
}
