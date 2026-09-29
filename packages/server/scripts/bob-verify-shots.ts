/**
 * bob-verify-shots.ts — run ONLY the screenshot verifier (ST6e) on an already-saved walkthrough,
 * without a new analysis. Same code path as the live pipeline (src/verify/bob-verifier.ts), so a
 * result here is a result there. Spends Bobcoins (budget-guarded, logged to the spend ledger).
 *
 *   bob:verify-shots owner/repo#N                    trial: writes data/shots/…/N-bob-trial/, leaves the walkthrough alone
 *   bob:verify-shots owner/repo#N --apply            also updates the saved walkthrough exactly like the pipeline does
 *                                                    (shots or an honest note, per-symptom frames, verification status)
 *   … --ablate                                       then runs the $0 ablation and writes the per-step evidence
 *   … --revise                                       then, only if the measurements contradict the prose, the paid revise
 *   … --resume <taskId> --spent <usd>                finish an earlier, already-paid verifier session (its repro was
 *                                                    rejected or it ran out of budget) instead of starting a new one:
 *                                                    costs at most the repair (VERIFY_REPAIR_MAX_COST, default $1)
 *
 *   … --reuse                                        $0: no Bob. Re-confirm the scenario scripts saved by an earlier run against the
 *                                                    live builds and rebuild all frames/crops/cards with the current code
 *
 * VERIFY_MAX_COST (default 2) caps a fresh Bob run.
 */
import "../src/env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWalkthrough, saveWalkthrough } from "../src/storage.js";
import { verifyShots } from "../src/verify/bob-verifier.js";
import { ablationHasSignal, runAblation, verdictForStep } from "../src/verify/ablation.js";
import { recipeFor } from "../src/verify/recipes.js";
import { attachSymptomShots } from "../src/verify/symptom-shots.js";
import { markVerified, recordNoShots, recordShotsNote } from "../src/verify/shots-status.js";
import { ablationContradictsWalkthrough, reviseFromAblation } from "../src/verify/revise.js";
import { checkQuality } from "../src/validation/quality.js";
import { prepareWorkspace } from "../src/git/workspace.js";
import { blobsEnabled, uploadDir } from "../src/blobs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";

const flag = (name: string) => process.argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const spec = process.argv[2] ?? "";
const apply = flag("apply");
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(spec);
if (!m) throw new Error(`Usage: bob:verify-shots owner/repo#number [--apply] [--ablate] [--revise] [--resume <taskId> --spent <usd>] (got "${spec}")`);
const [, owner, repo, num] = m;

const resumeTask = value("resume");
const spent = Number(value("spent") ?? NaN);
if (resumeTask && !(spent >= 0)) throw new Error("--resume needs --spent <usd>: the task's cumulative cost so far (the resume's cap is built on it)");

let wt = await loadWalkthrough(owner, repo, Number(num));
if (!wt) throw new Error(`No saved walkthrough for ${spec}`);

const outDir = path.join(ROOT, "data/shots", owner, repo, apply ? num : `${num}-bob-trial`);
console.log(`bob-verify-shots ${spec} → ${path.relative(ROOT, outDir)}${apply ? " (apply)" : " (trial)"}${resumeTask ? ` — resuming task ${resumeTask}` : ""}`);

// The pipeline hands the verifier the PR diff; so does this script.
const workspace = await prepareWorkspace(`https://github.com/${owner}/${repo}`, wt.pr.headSha!, wt.pr.baseSha!, wt.pr.number, GIT_CACHE_DIR);
const diff = await workspace.diff();

const result = await verifyShots({
  walkthrough: wt,
  outDir,
  diff,
  ...(resumeTask ? { recover: { taskId: resumeTask, spent } } : {}),
  ...(flag("reuse") ? { reuseSaved: true } : {}),
  onStage: (stage, label) => console.log(`• [${stage}] ${label}`),
});

console.log(`session cost so far $${result.costUsd.toFixed(3)}`);

if (result.status === "skipped") {
  console.log(`skipped (${result.kind ?? "failed"}): ${result.reason}`);
  if (apply) {
    recordNoShots(wt, result.reason, result.kind === "declined" ? { alreadyPlain: true } : {});
    await saveWalkthrough(wt);
    console.log(`walkthrough.verification recorded: ${wt.verification?.skipReason}`);
  }
  process.exit(0);
}

console.log(result.shots ? JSON.stringify(result.shots, null, 2) : `no before/after pair: ${result.shotsNote}`);
if (result.symptomSrcs?.size) {
  console.log("symptom srcs:", Object.fromEntries([...result.symptomSrcs.entries()].map(([k, v]) => [String(k), v])));
}

if (apply) {
  markVerified(wt);
  if (result.shots) wt.shots = result.shots;
  if (result.shotsNote) recordShotsNote(wt, result.shotsNote);
  if (result.symptomSrcs?.size) attachSymptomShots(wt, result.symptomSrcs);
  await saveWalkthrough(wt);
  console.log("walkthrough updated (verification passed, shots / note, symptom frames)");
}

if (flag("ablate")) {
  const recipe = recipeFor(owner, repo);
  if (!recipe || !wt.pr.baseSha) {
    console.log("ablation skipped: no recipe or baseSha");
  } else {
    console.log("\nrunning ablation…");
    const ablation = await runAblation({
      mainPath: path.join(GIT_CACHE_DIR, `${owner}__${repo}`),
      baseSha: wt.pr.baseSha,
      diff,
      hunks: wt.hunks,
      skippedHunks: wt.skippedHunks,
      recipe,
      reproPath: result.reproPath,
      ...(result.scenarios ? { scenarios: result.scenarios } : {}),
      onProgress: (msg) => console.log("  •", msg),
    });
    if (!ablation) {
      console.log("ablation: nothing to measure (≤1 logic unit)");
    } else if (!ablationHasSignal(ablation)) {
      console.log("ablation: every run was broken — not recorded", JSON.stringify(ablation.runs.map((r) => [r.mode, r.verdict, r.detail])));
    } else {
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

      const contradicts = ablationContradictsWalkthrough(wt, ablation);
      console.log(`\nablation contradicts the prose: ${contradicts}`);
      if (flag("revise") && contradicts && apply) {
        console.log("running the paid revise…");
        const revised = await reviseFromAblation({
          walkthrough: wt,
          ablation,
          repoPath: workspace.repoPath,
          diff,
          measures: result.measures,
          prLabel: `${owner}/${repo}#${num}`,
        });
        console.log(`revise: ${revised.status}${"reason" in revised ? ` — ${revised.reason}` : ""} (cost $${revised.costUsd.toFixed(3)})`);
        if (revised.status === "ok") {
          wt = revised.walkthrough;
          if (result.symptomSrcs?.size) attachSymptomShots(wt, result.symptomSrcs);
          await saveWalkthrough(wt);
          console.log(`saved; quality warnings now: ${checkQuality(wt).map((w) => w.code).join(", ") || "none"}`);
        }
      }
    }
  }
}

// The pipeline uploads a finished run's frames to Storage so they outlive the server; do the same.
if (apply && blobsEnabled()) {
  try {
    const n = await uploadDir(outDir, `shots/${owner}/${repo}/${num}`);
    console.log(`uploaded ${n} shot file(s) to Storage`);
  } catch (err) {
    console.warn("could not upload shots to Storage:", err instanceof Error ? err.message : err);
  }
}
