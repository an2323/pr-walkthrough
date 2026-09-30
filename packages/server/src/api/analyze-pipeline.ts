/**
 * analyze-pipeline.ts — runs one PR analysis in the background and reports
 * progress through the job store (jobs.ts). This is the async counterpart of
 * the old synchronous `POST /api/analyze` handler: same steps (fetch meta →
 * prepare workspace → parse hunks → analyze → validate → save → quality
 * check → optional shots/ablation/revise), instrumented with `ProgressEvent`s.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseHunks, type ProgressEvent, type Walkthrough } from "@pr-walkthrough/shared";

import { emitProgress, completeJob, failJob } from "./jobs.js";
import { plainJobError } from "./plain-error.js";
import { fetchPRMeta } from "../github/client.js";
import { prepareWorkspace, pruneWorktrees } from "../git/workspace.js";
import { BobShellAnalyzer, createAnalyzer, CachedAnalyzer } from "../analyzer/index.js";
import { withRehearsal } from "../analyzer/bob-command.js";
import { classifyHunks } from "../analyzer/classify-hunks.js";
import { createProgressNormalizer, type RunSpend } from "../analyzer/progress-normalizer.js";
import { answerOf, qualityRepairBob } from "../analyzer/bob-shell.js";
import { assembleDraft, backendEvidenceOf, carryBackendEvidence } from "../analyzer/assemble.js";
import { assertBudget, recordSpend } from "../analyzer/budget.js";
import { canVerify, verifyShots } from "../verify/bob-verifier.js";
import { ablationHasSignal, runAblation, verdictForStep } from "../verify/ablation.js";
import { recipeFor, resolveRecipe } from "../verify/recipes.js";
import { attachSymptomShots } from "../verify/symptom-shots.js";
import { ablationContradictsWalkthrough, reviseFromAblation } from "../verify/revise.js";
import { shouldAttemptShots } from "../verify/should-attempt-shots.js";
import { markVerified, plainNoShotsReason, recordNoShots, recordShotsNote } from "../verify/shots-status.js";
import { confirmedEvents, emitAll, filesEvent, outcomeEvent, planEvent, scenarioEvent, shotsNotPlannedReason, skippedOutcome } from "./progress-events.js";
import { validate, checkQuality, criticalQualityWarnings } from "../validation/index.js";
import { loadWalkthrough, saveWalkthrough } from "../storage.js";
import { blobsEnabled, uploadBlob, uploadDir } from "../blobs.js";
import { voiceWalkthrough, voicingConfigured } from "../tts/voice-stage.js";
import { factCheck, type ScenarioFact } from "../verify/fact-check.js";

const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const QUALITY_REPAIR_MAX_COST = Number(process.env.QUALITY_REPAIR_MAX_COST ?? 1);

/**
 * Run the pipeline for `jobId`, reporting through `emitProgress` and
 * finishing with `completeJob`/`failJob`. Never throws — it runs detached
 * from any HTTP request (`POST /api/analyze` has already responded with the
 * jobId), so every error is caught and turned into a `failJob` + "error"
 * progress event instead.
 */
export async function runAnalyzeJob(
  jobId: string,
  owner: string,
  repo: string,
  number: number,
  baseUrl: string,
  opts: { force?: boolean; rehearsal?: { plan?: string } } = {}
): Promise<void> {
  if (!opts.rehearsal) return runPipeline(jobId, owner, repo, number, baseUrl, { force: opts.force });
  // Rehearsal: the whole pipeline for real, Bob replaced by fake-bob answering with the last
  // real result of this PR (and its confirmed scenario scripts). $0, nothing overwritten.
  const answersDir = path.join(ROOT, "data/rehearsals/answers", owner, repo, String(number));
  try {
    const previous = await loadWalkthrough(owner, repo, number);
    if (!previous) throw new Error(`nothing to rehearse with: ${owner}/${repo}#${number} has no finished walkthrough yet`);
    await rm(answersDir, { recursive: true, force: true });
    await mkdir(answersDir, { recursive: true });
    await writeFile(path.join(answersDir, "walkthrough.json"), JSON.stringify(previous));
    const saved = path.join(ROOT, "data/verify", owner, repo, String(number));
    if (existsSync(saved)) await cp(saved, path.join(answersDir, "verify"), { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitProgress(jobId, { kind: "error", t: 0, message });
    failJob(jobId, message);
    return;
  }
  return withRehearsal({ answersDir, plan: opts.rehearsal.plan }, () =>
    runPipeline(jobId, owner, repo, number, baseUrl, { force: true, rehearsal: true, rehearsalPlan: opts.rehearsal!.plan })
  );
}

async function runPipeline(
  jobId: string,
  owner: string,
  repo: string,
  number: number,
  baseUrl: string,
  opts: { force?: boolean; rehearsal?: boolean; rehearsalPlan?: string }
): Promise<void> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const progressLog: ProgressEvent[] = [];
  const emit = (e: ProgressEvent): void => {
    progressLog.push(e);
    emitProgress(jobId, e);
  };
  const walkthroughUrl = `${baseUrl}/api/walkthroughs/${owner}/${repo}/${number}${opts.rehearsal ? "?rehearsal=1" : ""}`;
  const analyzerType = opts.rehearsal ? "bob" : (process.env.ANALYZER ?? "cached");
  // False for the "already analysed" fast path: that job only re-emits `done`, and must not
  // overwrite the real run's replay in Storage with a one-event stub.
  let ranPipeline = false;

  try {
    // ------------------------------------------------------------------
    // cached mode — no Bob, no workspace: either the file is there or it isn't.
    // ------------------------------------------------------------------
    if (analyzerType === "cached") {
      emit({ kind: "stage", t: elapsed(), stage: "clone", label: "Loading the cached walkthrough" });
      const cached = new CachedAnalyzer();
      const minimalInput = {
        repoPath: "",
        baseSha: "",
        headSha: "",
        pr: {
          repo: `${owner}/${repo}`,
          number,
          title: "",
          url: "",
          author: "",
          filesChanged: 0,
          additions: 0,
          deletions: 0,
          commitTitles: [],
        },
        hunks: [],
        diff: "",
      };
      await cached.analyze(minimalInput);
      emit({ kind: "done", t: elapsed(), walkthroughUrl, durationMs: elapsed() });
      completeJob(jobId, { walkthroughUrl });
      return;
    }

    // ------------------------------------------------------------------
    // bob mode — full pipeline
    // ------------------------------------------------------------------
    if (!opts.force && (await loadWalkthrough(owner, repo, number))) {
      emit({ kind: "done", t: elapsed(), walkthroughUrl, durationMs: elapsed() });
      completeJob(jobId, { walkthroughUrl });
      return;
    }

    ranPipeline = true;
    emit({ kind: "stage", t: elapsed(), stage: "clone", label: "Preparing the git workspace" });
    const pr = await fetchPRMeta(owner, repo, number);
    // A fork (a PR copied into the user's own fork) runs the parent's app: without this it silently
    // got "no app recipe" — no screenshots, no ablation.
    await resolveRecipe(owner, repo);
    // Tell the screen up front whether screenshots are planned for this repository — it is known now.
    const canShots = process.env.VERIFY_SHOTS !== "0" && canVerify(`${owner}/${repo}`);
    emit(planEvent(elapsed(), pr, shotsNotPlannedReason(canVerify(`${owner}/${repo}`), process.env.VERIFY_SHOTS === "0", `${owner}/${repo}`)));
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const workspace = await prepareWorkspace(repoUrl, pr.headSha!, pr.baseSha!, number, GIT_CACHE_DIR);
    const diff = await workspace.diff();
    const hunks = parseHunks(diff);
    const { skipped } = classifyHunks(hunks);
    emit(filesEvent(elapsed(), hunks, skipped));

    emit({
      kind: "stage",
      t: elapsed(),
      stage: "hunks",
      label:
        skipped.length > 0
          ? `${hunks.length} hunks (${skipped.length} auto-skipped)`
          : `${hunks.length} hunks`,
    });

    // One running total for the progress screen, across the analysis task and the verifier task.
    const spend: RunSpend = {
      tasks: new Map(),
      maxUsd:
        Number(process.env.MAX_COST ?? 8) + QUALITY_REPAIR_MAX_COST +
        Number(process.env.VERIFY_MAX_COST ?? 2) + Number(process.env.VERIFY_REPAIR_MAX_COST ?? 1) +
        Number(process.env.FACTCHECK_MAX_COST ?? 0.6),
    };
    const normalizer = createProgressNormalizer(started, emit, { tracker: spend, task: "analysis" });
    emit({ kind: "stage", t: elapsed(), stage: "analyzing", label: "Bob is analyzing the PR" });

    const analyzer = opts.rehearsal ? new BobShellAnalyzer() : createAnalyzer();
    const input = {
      repoPath: workspace.repoPath,
      baseSha: pr.baseSha!,
      headSha: pr.headSha!,
      pr,
      hunks,
      diff,
      onEvent: (raw: unknown) => normalizer.handle(raw, Date.now()),
    };
    const draft = await analyzer.analyze(input);

    emit({ kind: "stage", t: elapsed(), stage: "validating", label: "Validating the walkthrough" });
    let result = await validate(draft, input, workspace);
    if (!result.valid || !result.walkthrough) {
      throw new Error(`Validation failed: ${result.errors.slice(0, 3).join("; ")}`);
    }

    let walkthrough: Walkthrough = result.walkthrough;
    // What the verifier will try in the running app — the analysis already wrote it.
    if (canShots) emitAll(emit, [scenarioEvent(elapsed(), walkthrough.verification?.scenario)]);
    // Per-symptom frames from the verifier; kept here so every later rewrite by Bob can re-attach them.
    let symptomSrcs: Map<number, string> | undefined;
    // Measured BASE/HEAD facts of every confirmed scenario (for the fact check).
    let scenarioFacts: ScenarioFact[] = [];
    // Quality-repair spend that is NOT already inside `meta.run.costUsd` (a failed resume still costs).
    let qualityOrphanCost = 0;

    /**
     * Q2 — one quality repair via --resume for critical output-contract issues. Runs after the analysis
     * AND again after a revise: revise rewrites steps, and its rewrites broke the same rules (an
     * identifier in `say`, a 10-word headline) that the first pass had just fixed.
     */
    const repairQuality = async (): Promise<void> => {
      if (process.env.VERIFY_QUALITY_REPAIR === "0") return;
      const critical = criticalQualityWarnings(checkQuality(walkthrough));
      const taskId = walkthrough.meta.run?.taskId;
      if (critical.length === 0 || !taskId) return;
      emit({ kind: "stage", t: elapsed(), stage: "repairing", label: `Fixing ${critical.length} quality issue(s)` });
      console.log(`[analyze-pipeline] quality issues sent to repair:\n${critical.map((w) => `  - ${w.stepId ?? "-"} ${w.code}: ${w.message}`).join("\n")}`);
      try {
        const previousCost = walkthrough.meta.run?.costUsd ?? 0;
        const cap = (previousCost + QUALITY_REPAIR_MAX_COST).toFixed(2);
        await assertBudget(QUALITY_REPAIR_MAX_COST);
        const repairEvents = createProgressNormalizer(started, emit, { tracker: spend, task: "analysis" });
        const repairRun = await qualityRepairBob(
          taskId,
          critical.map((w) => w.message),
          workspace.repoPath,
          cap,
          (raw) => repairEvents.handle(raw, Date.now())
        );
        const cost = Math.max(0, repairRun.sessionCost - previousCost);
        const repaired = answerOf(repairRun);
        const base = {
          pr: `${owner}/${repo}#${number}`,
          mode: "quality-repair",
          maxCost: QUALITY_REPAIR_MAX_COST,
          actualCost: cost,
          durationSec: Math.round(repairRun.ms / 1000),
          toolCalls: repairRun.toolCalls,
          subagents: repairRun.subagents,
          repairs: 1,
        };
        if (repaired) {
          const repairedResult = await validate(
            assembleDraft(repaired, walkthrough.pr, hunks) as unknown as Walkthrough,
            input,
            workspace
          );
          await recordSpend({
            ...base,
            valid: repairedResult.valid,
            notes: repairedResult.valid
              ? `fixed ${critical.length} critical quality warning(s)`
              : repairedResult.errors.slice(0, 3).join("; "),
          });
          // Always fold Bob's cumulative task spend into meta — even when we reject the repaired
          // draft — so a later resume doesn't double-count this increment in the done event.
          if (walkthrough.meta.run) {
            walkthrough.meta.run = {
              ...walkthrough.meta.run,
              costUsd: repairRun.sessionCost,
              maxCostUsd: Number(cap),
              durationMs: (walkthrough.meta.run.durationMs ?? 0) + repairRun.ms,
              toolCalls: repairRun.toolCalls,
              subagents: Math.max(walkthrough.meta.run.subagents ?? 0, repairRun.subagents),
              repairs: (walkthrough.meta.run.repairs ?? 0) + 1,
            };
          } else {
            qualityOrphanCost += cost;
          }
          if (repairedResult.valid && repairedResult.walkthrough) {
            // A repair that follows the screenshot/revise stages must not lose what they attached
            // (frames, symptom cards, ablation verdicts, the cumulative run stats).
            const evidence = backendEvidenceOf(walkthrough, { symptomSrcs });
            walkthrough = carryBackendEvidence(repairedResult.walkthrough, evidence, { keepRun: true });
          } else {
            console.warn("[analyze-pipeline] quality repair failed validation — keeping pre-repair draft");
          }
        } else {
          await recordSpend({ ...base, valid: false, notes: repairRun.errorMessage ?? "no walkthrough in quality-repair output" });
          if (walkthrough.meta.run && cost > 0) {
            walkthrough.meta.run = {
              ...walkthrough.meta.run,
              costUsd: repairRun.sessionCost,
              repairs: (walkthrough.meta.run.repairs ?? 0) + 1,
            };
          } else {
            qualityOrphanCost += cost;
          }
        }
      } catch (err) {
        console.warn("[analyze-pipeline] quality repair failed:", err instanceof Error ? err.message : err);
      }
    };

    await repairQuality();

    emit({ kind: "stage", t: elapsed(), stage: "saving", label: "Saving the walkthrough" });
    await saveWalkthrough(walkthrough);
    let qualityWarnings = checkQuality(walkthrough);

    let verifierCost = 0;
    let reviseCost = 0;
    let reviseFoldedIntoMeta = false;

    if (process.env.VERIFY_SHOTS !== "0" && canVerify(walkthrough.pr.repo)) {
      const shotGate = shouldAttemptShots(walkthrough);
      if (!shotGate.attempt) {
        recordNoShots(walkthrough, shotGate.reason);
        await saveWalkthrough(walkthrough);
        emit({
          kind: "stage",
          t: elapsed(),
          stage: "shots",
          label: `Screenshots skipped: ${plainNoShotsReason(shotGate.reason)}`,
        });
        emit(skippedOutcome(elapsed(), shotGate.reason));
      } else {
        // If the process dies mid-stage (restart, OOM) the saved walkthrough must already say
        // why it has no screenshots — the placeholder is replaced by the real outcome below.
        recordNoShots(walkthrough, "the screenshot step didn't finish.", { alreadyPlain: true });
        await saveWalkthrough(walkthrough);

        // Free disk first: every earlier PR left two installed worktrees behind.
        try {
          const mainPath = path.join(GIT_CACHE_DIR, `${owner}__${repo}`);
          const keep = [walkthrough.pr.headSha, walkthrough.pr.baseSha].filter((x): x is string => !!x);
          const removed = await pruneWorktrees(mainPath, keep);
          if (removed.length > 0) console.log(`[analyze-pipeline] pruned ${removed.length} old worktree(s)`);
        } catch (err) {
          console.warn("[analyze-pipeline] worktree pruning failed (continuing):", err instanceof Error ? err.message : err);
        }

        const verifierEvents = createProgressNormalizer(started, emit, { tracker: spend, task: "verifier" });
        try {
          const vr = await verifyShots({
            walkthrough,
            diff,
            outDir: path.join(ROOT, "data/shots", owner, repo, String(number)),
            onStage: (stage, label) => emit({ kind: "stage", t: elapsed(), stage, label }),
            onEvent: (raw) => verifierEvents.handle(raw, Date.now()),
          });
          verifierCost = vr.costUsd;
          if (vr.status === "ok") {
            // The repro is confirmed: replace the placeholder with the real status.
            markVerified(walkthrough);
            if (vr.shots) walkthrough.shots = vr.shots;
            if (vr.shotsNote) recordShotsNote(walkthrough, vr.shotsNote);
            scenarioFacts = vr.facts ?? [];
            if (vr.symptomSrcs && vr.symptomSrcs.size > 0) {
              symptomSrcs = vr.symptomSrcs;
              attachSymptomShots(walkthrough, vr.symptomSrcs);
              emit({
                kind: "stage",
                t: elapsed(),
                stage: "shots",
                label: `Attached ${vr.symptomSrcs.size} per-symptom screenshot(s)`,
              });
            }
            await saveWalkthrough(walkthrough);
            emit({
              kind: "stage",
              t: elapsed(),
              stage: "shots",
              label: vr.shots
                ? "Screenshots taken by Bob"
                : "Bug reproduced — no side-by-side shots for this one",
            });
            emitAll(emit, confirmedEvents(elapsed(), vr.shots, vr.shotsNote));

            const recipe = recipeFor(owner, repo);
            if (process.env.VERIFY_ABLATION !== "0" && recipe && walkthrough.pr.baseSha) {
              emit({ kind: "stage", t: elapsed(), stage: "shots", label: "Testing which changes fix the bug" });
              try {
                const ablation = await runAblation({
                  mainPath: path.join(GIT_CACHE_DIR, `${owner}__${repo}`),
                  baseSha: walkthrough.pr.baseSha,
                  diff,
                  hunks: walkthrough.hunks,
                  skippedHunks: walkthrough.skippedHunks,
                  recipe,
                  reproPath: vr.reproPath,
                  ...(vr.scenarios ? { scenarios: vr.scenarios } : {}),
                  onProgress: (msg) => emit({ kind: "stage", t: elapsed(), stage: "shots", label: msg }),
                });
                // A table of only "broken" runs says nothing — don't present it as a measurement.
                if (ablation && ablationHasSignal(ablation)) {
                  walkthrough.verification = {
                    ...walkthrough.verification,
                    status: "passed",
                    scenario: walkthrough.verification?.scenario ?? [],
                    ablation,
                  };
                  for (const step of walkthrough.steps) {
                    const verdict = verdictForStep(ablation, step.hunkIds);
                    if (verdict) step.evidence = { source: "ablation", verdict };
                  }
                  await saveWalkthrough(walkthrough);
                  emit({
                    kind: "stage",
                    t: elapsed(),
                    stage: "shots",
                    label: `Measured ${ablation.units.length} change(s) against the running app`,
                  });

                  // Q1 — evidence-based revise, only when the measurements contradict the prose.
                  // (The repro's own BASE/HEAD measurements come from the verifier — no re-run.)
                  if (process.env.VERIFY_REVISE !== "0" && ablationContradictsWalkthrough(walkthrough, ablation)) {
                    emit({
                      kind: "stage",
                      t: elapsed(),
                      stage: "repairing",
                      label: "Revising the explanation from measured evidence",
                    });
                    const reviseEvents = createProgressNormalizer(started, emit, { tracker: spend, task: "analysis" });
                    try {
                      const revised = await reviseFromAblation({
                        walkthrough,
                        ablation,
                        repoPath: workspace.repoPath,
                        diff,
                        measures: vr.measures,
                        prLabel: `${owner}/${repo}#${number}`,
                        onEvent: (raw) => reviseEvents.handle(raw, Date.now()),
                      });
                      if (revised.status === "ok") {
                        reviseCost = revised.costUsd;
                        reviseFoldedIntoMeta = true;
                        // Bob returns the steps without the screenshot paths the backend attached
                        // to the symptoms — put them back, or the frames we paid for vanish.
                        // Revise brings its own cumulative meta.run, so that one is kept.
                        walkthrough = carryBackendEvidence(
                          revised.walkthrough,
                          backendEvidenceOf(walkthrough, { symptomSrcs })
                        );
                        await saveWalkthrough(walkthrough);
                        emit({
                          kind: "stage",
                          t: elapsed(),
                          stage: "repairing",
                          label: "Explanation revised to match measured evidence",
                        });
                        // The rewritten steps go through the same output-contract repair as the first draft.
                        await repairQuality();
                        await saveWalkthrough(walkthrough);
                        qualityWarnings = checkQuality(walkthrough);
                      } else if (revised.status === "skipped") {
                        emit({
                          kind: "stage",
                          t: elapsed(),
                          stage: "repairing",
                          label: `Revise skipped: ${revised.reason.slice(0, 120)}`,
                        });
                      } else {
                        reviseCost = revised.costUsd;
                        if (walkthrough.meta.run && reviseCost > 0) {
                          walkthrough.meta.run = {
                            ...walkthrough.meta.run,
                            costUsd: (walkthrough.meta.run.costUsd ?? 0) + reviseCost,
                            repairs: (walkthrough.meta.run.repairs ?? 0) + 1,
                          };
                          reviseFoldedIntoMeta = true;
                        }
                        emit({
                          kind: "stage",
                          t: elapsed(),
                          stage: "repairing",
                          label: `Revise failed (kept prior draft): ${revised.reason.slice(0, 100)}`,
                        });
                      }
                    } catch (err) {
                      console.warn(
                        "[analyze-pipeline] revise failed:",
                        err instanceof Error ? err.message : err
                      );
                    }
                  }
                } else if (ablation) {
                  console.warn("[analyze-pipeline] ablation gave no usable runs — not recorded");
                }
              } catch (err) {
                console.warn(
                  "[analyze-pipeline] ablation failed:",
                  err instanceof Error ? err.message : err
                );
              }
            }
          } else {
            recordNoShots(walkthrough, vr.reason, vr.kind === "declined" ? { alreadyPlain: true } : {});
            await saveWalkthrough(walkthrough);
            emit({
              kind: "stage",
              t: elapsed(),
              stage: "shots",
              label: `Screenshots skipped: ${vr.kind === "declined" ? vr.reason.slice(0, 160) : plainNoShotsReason(vr.reason)}`,
            });
            emit(skippedOutcome(elapsed(), vr.reason, vr.kind === "declined" ? { alreadyPlain: true } : {}));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[analyze-pipeline] screenshot verifier failed:", message);
          recordNoShots(walkthrough, "screenshots couldn't be captured this time.", { alreadyPlain: true });
          await saveWalkthrough(walkthrough);
          emit({
            kind: "stage",
            t: elapsed(),
            stage: "shots",
            // The raw error stays in the log above; the screen gets a sentence, never the exception text.
            label: "Screenshots couldn't be captured this time",
          });
          emit(outcomeEvent(elapsed(), "unavailable", "Screenshots couldn't be captured this time."));
        }
      }
    } else {
      // The common case for most repositories (no app recipe) — say so instead of leaving a silent gap.
      const notPlannedRaw =
        process.env.VERIFY_SHOTS === "0" ? "screenshots turned off (VERIFY_SHOTS=0)" : `no app recipe for ${walkthrough.pr.repo}`;
      recordNoShots(walkthrough, notPlannedRaw);
      await saveWalkthrough(walkthrough);
      emit(skippedOutcome(elapsed(), notPlannedRaw));
    }

    // Fact check: the prose against what the running app measured (only after a confirmed repro).
    if (process.env.VERIFY_FACTCHECK !== "0" && scenarioFacts.length > 0 && walkthrough.verification?.status === "passed") {
      emit({ kind: "stage", t: elapsed(), stage: "repairing", label: "Checking the text against the running app" });
      try {
        const fc = await factCheck({
          walkthrough,
          facts: scenarioFacts,
          repoPath: workspace.repoPath,
          prLabel: `${owner}/${repo}#${number}`,
          onEvent: (() => {
            const n = createProgressNormalizer(started, emit, { tracker: spend, task: "analysis" });
            return (raw: unknown) => n.handle(raw, Date.now());
          })(),
        });
        // The resume's cost is the analysis task's new cumulative total, like the quality repair's.
        if (fc.sessionCost !== undefined && fc.sessionCost > 0) {
          if (walkthrough.meta.run) walkthrough.meta.run = { ...walkthrough.meta.run, costUsd: Math.max(walkthrough.meta.run.costUsd ?? 0, fc.sessionCost) };
          else qualityOrphanCost += fc.costUsd;
        }
        if (fc.status === "ok") {
          console.log(`[analyze-pipeline] fact check corrected: ${fc.changed.join(", ")}`);
          const run = walkthrough.meta.run;
          walkthrough = fc.walkthrough;
          if (run) walkthrough.meta.run = run;
          emit({ kind: "stage", t: elapsed(), stage: "repairing", label: `Corrected ${fc.changed.length} sentence(s) to match the running app` });
          await repairQuality();
          await saveWalkthrough(walkthrough);
          qualityWarnings = checkQuality(walkthrough);
        } else {
          emit({
            kind: "stage",
            t: elapsed(),
            stage: "repairing",
            label: fc.status === "unchanged" ? "Text matches the running app" : `Fact check skipped: ${fc.reason.slice(0, 100)}`,
          });
        }
      } catch (err) {
        console.warn("[analyze-pipeline] fact check failed:", err instanceof Error ? err.message : err);
      }
    }

    // Voice last: the text is final now. A rehearsal only voices with plan tts=on (it costs characters).
    const voiceWanted = !opts.rehearsal || /(^|,)tts=on(,|$)/.test(opts.rehearsalPlan ?? "");
    if (voiceWanted && voicingConfigured()) {
      emit({ kind: "stage", t: elapsed(), stage: "voicing", label: "Recording the narration" });
      const voice = await voiceWalkthrough(walkthrough, ROOT);
      emit({
        kind: "stage",
        t: elapsed(),
        stage: "voicing",
        label:
          voice.status === "ok"
            ? `Narration recorded (${voice.generated} new, ${voice.cached} reused)`
            : `Narration not recorded — the browser voice will read it (${voice.reason.slice(0, 120)})`,
      });
    }

    // Successful quality/revise resumes fold their spend into meta.run.costUsd
    // (Bob's cumulative task total). Failed ones still spent — add the increment.
    // Verifier is a separate Bob task, always additive.
    const run = walkthrough.meta.run;
    const orphanResumeCost = qualityOrphanCost + (reviseFoldedIntoMeta ? 0 : reviseCost);
    emit({
      kind: "done",
      t: elapsed(),
      walkthroughUrl,
      durationMs: elapsed(),
      costUsd:
        run?.costUsd !== undefined
          ? run.costUsd + verifierCost + orphanResumeCost
          : undefined,
      toolCalls: run?.toolCalls,
      subagents: run?.subagents,
    });
    completeJob(jobId, { walkthroughUrl, qualityWarnings });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error(`[analyze-pipeline] ${owner}/${repo}#${number} failed:`, raw);
    const message = plainJobError(raw);
    emit({ kind: "error", t: elapsed(), message });
    failJob(jobId, message);
  } finally {
    if (analyzerType === "bob" && ranPipeline && progressLog.length > 0) {
      try {
        const stamp = new Date(started).toISOString().replace(/[:.]/g, "-");
        const runDir = path.join(ROOT, "data/runs", `${stamp}-${repo}-${number}-${opts.rehearsal ? "rehearsal" : "live"}`);
        await mkdir(runDir, { recursive: true });
        await writeFile(
          path.join(runDir, "progress.ndjson"),
          progressLog.map((e) => JSON.stringify(e)).join("\n") + "\n"
        );
      } catch (err) {
        console.warn("[analyze-pipeline] could not persist progress.ndjson (best effort):", err);
      }
    }
    if (analyzerType === "bob" && !opts.rehearsal && ranPipeline && blobsEnabled() && progressLog.at(-1)?.kind === "done") {
      try {
        const shots = await uploadDir(
          path.join(ROOT, "data/shots", owner, repo, String(number)),
          `shots/${owner}/${repo}/${number}`
        );
        await uploadBlob(
          `events/${owner}/${repo}/${number}.ndjson`,
          progressLog.map((e) => JSON.stringify(e)).join("\n") + "\n"
        );
        console.log(`[analyze-pipeline] uploaded ${shots} shot file(s) + recording for ${owner}/${repo}#${number}`);
      } catch (err) {
        console.warn("[analyze-pipeline] could not upload assets to Supabase Storage:", err);
      }
    }
  }
}
