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
 *   … --factcheck                                    then the paid fact check (prose vs what the scenarios measured)
 *   … --voice                                        record narration audio even if no text changed (it is
 *                                                    recorded automatically whenever a revise/fact check rewrote it)
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
import { resolveRecipe } from "../src/verify/recipes.js";
import { attachSymptomShots } from "../src/verify/symptom-shots.js";
import { markVerified, recordNoShots, recordShotsNote } from "../src/verify/shots-status.js";
import { ablationContradictsWalkthrough, reviseFromAblation } from "../src/verify/revise.js";
import { checkQuality, criticalQualityWarnings } from "../src/validation/quality.js";
import { factCheck } from "../src/verify/fact-check.js";
import { removeSymptoms, symptomsToDrop } from "../src/verify/unchanged-symptoms.js";
import { voiceWalkthrough, voicingConfigured } from "../src/tts/voice-stage.js";
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
const narrationBefore = JSON.stringify(wt.steps.map((s) => s.narration));

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
  // A re-render or retry that failed must not overwrite evidence an earlier run already confirmed.
  if (apply && wt.verification?.status === "passed" && result.kind !== "declined") {
    console.log("walkthrough left as it was: it is already verified, and this attempt failed");
    process.exit(1);
  }
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
  attachSymptomShots(wt, result.symptomSrcs ?? new Map()); // the complete set — clears cards a newer render no longer makes
  await saveWalkthrough(wt);
  console.log("walkthrough updated (verification passed, shots / note, symptom frames)");
}
// Listed symptoms the verifier found unchanged by the PR: shown to the fact check, removed at the end.
const drops = symptomsToDrop(wt, result.unchanged ?? []);
if (drops.length) console.log("not changed by the PR:", drops.map((d) => `[${d.index}] "${d.text}" — ${d.why}`).join("; "));

if (flag("ablate")) {
  const recipe = await resolveRecipe(owner, repo);
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
          attachSymptomShots(wt, result.symptomSrcs ?? new Map()); // the complete set — clears cards a newer render no longer makes
          await saveWalkthrough(wt);
          console.log(`saved; quality warnings now: ${checkQuality(wt).map((w) => w.code).join(", ") || "none"}`);
        }
      }
    }
  }
}

if (flag("factcheck")) {
  // The same fact check the pipeline runs: one resume of the analysis session (paid, small).
  console.log("\nfact check against the running app…");
  const fc = await factCheck({ walkthrough: wt, facts: result.facts ?? [], dropped: drops, repoPath: workspace.repoPath, prLabel: `${owner}/${repo}#${num}` });
  console.log(`fact check: ${fc.status}${"reason" in fc ? ` — ${fc.reason}` : ""}${"changed" in fc ? ` — ${fc.changed.join(", ")}` : ""} (cost $${fc.costUsd.toFixed(3)})`);
  if (fc.status === "ok") {
    for (const f of fc.changed) console.log(`  ${f}`);
    console.log("  plain.problem:", fc.walkthrough.plain?.problem);
    if (apply) {
      const run = wt.meta.run;
      wt = fc.walkthrough;
      if (run) wt.meta.run = { ...run, costUsd: Math.max(run.costUsd ?? 0, fc.sessionCost) };
      await saveWalkthrough(wt);
      console.log(`saved; critical quality warnings now: ${criticalQualityWarnings(checkQuality(wt)).map((w) => `${w.stepId}:${w.code}`).join(", ") || "none"}`);
    }
  }
}

if (apply && drops.length) {
  removeSymptoms(wt, drops);
  await saveWalkthrough(wt);
  console.log(`removed ${drops.length} symptom(s) the PR does not change`);
}

// A revise or fact check rewrote narration: record the new sentences, as the pipeline's last stage does
// (visitors never trigger paid audio — without this the rewritten sentences stay silent).
if (apply && (flag("voice") || JSON.stringify(wt.steps.map((s) => s.narration)) !== narrationBefore) && voicingConfigured()) {
  const voice = await voiceWalkthrough(wt, ROOT);
  console.log(`narration: ${voice.status}${voice.status === "ok" ? ` (${voice.generated} new, ${voice.cached} reused)` : ` — ${voice.reason}`}`);
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
