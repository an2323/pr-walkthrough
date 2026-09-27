/**
 * analyze-pipeline.ts — runs one PR analysis in the background and reports
 * progress through the job store (jobs.ts). This is the async counterpart of
 * the old synchronous `POST /api/analyze` handler: same steps (fetch meta →
 * prepare workspace → parse hunks → analyze → validate → save → quality
 * check → optional shots/ablation/revise), instrumented with `ProgressEvent`s.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseHunks, type ProgressEvent, type Walkthrough } from "@pr-walkthrough/shared";

import { emitProgress, completeJob, failJob } from "./jobs.js";
import { fetchPRMeta } from "../github/client.js";
import { prepareWorkspace } from "../git/workspace.js";
import { createAnalyzer, CachedAnalyzer } from "../analyzer/index.js";
import { classifyHunks } from "../analyzer/classify-hunks.js";
import { createProgressNormalizer } from "../analyzer/progress-normalizer.js";
import {
  findWalkthroughInEvents,
  normalizeDraft,
  qualityRepairBob,
} from "../analyzer/bob-shell.js";
import { assertBudget, recordSpend } from "../analyzer/budget.js";
import { canVerify, verifyShots } from "../verify/bob-verifier.js";
import { runAblation, verdictForStep, runRepro } from "../verify/ablation.js";
import { recipeFor } from "../verify/recipes.js";
import { attachSymptomShots } from "../verify/symptom-shots.js";
import { reviseFromAblation } from "../verify/revise.js";
import { shouldAttemptShots } from "../verify/should-attempt-shots.js";
import { startApp } from "../verify/app-servers.js";
import { ensureWorktree } from "../git/workspace.js";
import { validate, checkQuality, criticalQualityWarnings } from "../validation/index.js";
import { loadWalkthrough, saveWalkthrough } from "../storage.js";

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
  opts: { force?: boolean } = {}
): Promise<void> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const progressLog: ProgressEvent[] = [];
  const emit = (e: ProgressEvent): void => {
    progressLog.push(e);
    emitProgress(jobId, e);
  };
  const walkthroughUrl = `${baseUrl}/api/walkthroughs/${owner}/${repo}/${number}`;
  const analyzerType = process.env.ANALYZER ?? "cached";

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

    emit({ kind: "stage", t: elapsed(), stage: "clone", label: "Preparing the git workspace" });
    const pr = await fetchPRMeta(owner, repo, number);
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const workspace = await prepareWorkspace(repoUrl, pr.headSha!, pr.baseSha!, number, GIT_CACHE_DIR);
    const diff = await workspace.diff();
    const hunks = parseHunks(diff);
    const { skipped } = classifyHunks(hunks);

    emit({
      kind: "stage",
      t: elapsed(),
      stage: "hunks",
      label:
        skipped.length > 0
          ? `${hunks.length} hunks (${skipped.length} auto-skipped)`
          : `${hunks.length} hunks`,
    });

    const normalizer = createProgressNormalizer(started, emit);
    emit({ kind: "stage", t: elapsed(), stage: "analyzing", label: "Bob is analyzing the PR" });

    const analyzer = createAnalyzer();
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
      const message = `Validation failed: ${result.errors.slice(0, 3).join("; ")}`;
      emit({ kind: "error", t: elapsed(), message });
      failJob(jobId, message);
      return;
    }

    let walkthrough: Walkthrough = result.walkthrough;
    let qualityCost = 0;
    let qualityFoldedIntoMeta = false;

    // Q2 — one quality repair via --resume for critical output-contract issues.
    if (process.env.VERIFY_QUALITY_REPAIR !== "0") {
      const critical = criticalQualityWarnings(checkQuality(walkthrough));
      const taskId = walkthrough.meta.run?.taskId;
      if (critical.length > 0 && taskId) {
        emit({
          kind: "stage",
          t: elapsed(),
          stage: "repairing",
          label: `Fixing ${critical.length} quality issue(s)`,
        });
        try {
          const previousCost = walkthrough.meta.run?.costUsd ?? 0;
          const cap = (previousCost + QUALITY_REPAIR_MAX_COST).toFixed(2);
          await assertBudget(QUALITY_REPAIR_MAX_COST);
          const repairEvents = createProgressNormalizer(started, emit);
          const repairRun = await qualityRepairBob(
            taskId,
            critical.map((w) => w.message),
            workspace.repoPath,
            cap,
            (raw) => repairEvents.handle(raw, Date.now())
          );
          qualityCost = Math.max(0, repairRun.sessionCost - previousCost);
          const repaired = findWalkthroughInEvents(repairRun.events);
          if (repaired) {
            normalizeDraft(repaired);
            const repairedResult = await validate(
              { ...repaired, pr: walkthrough.pr } as unknown as Walkthrough,
              input,
              workspace
            );
            await recordSpend({
              pr: `${owner}/${repo}#${number}`,
              mode: "quality-repair",
              maxCost: QUALITY_REPAIR_MAX_COST,
              actualCost: qualityCost,
              durationSec: Math.round(repairRun.ms / 1000),
              toolCalls: repairRun.toolCalls,
              subagents: repairRun.subagents,
              repairs: 1,
              valid: repairedResult.valid,
              notes: repairedResult.valid
                ? `fixed ${critical.length} critical quality warning(s)`
                : repairedResult.errors.slice(0, 3).join("; "),
            });
            // Always fold Bob's cumulative task spend into meta — even when we
            // reject the repaired draft — so a later revise resume doesn't
            // double-count this increment in the done event.
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
              qualityFoldedIntoMeta = true;
            }
            if (repairedResult.valid && repairedResult.walkthrough) {
              const prevRun = walkthrough.meta.run;
              walkthrough = repairedResult.walkthrough;
              if (prevRun) walkthrough.meta.run = prevRun;
            } else {
              console.warn(
                "[analyze-pipeline] quality repair failed validation — keeping pre-repair draft"
              );
            }
          } else {
            await recordSpend({
              pr: `${owner}/${repo}#${number}`,
              mode: "quality-repair",
              maxCost: QUALITY_REPAIR_MAX_COST,
              actualCost: qualityCost,
              durationSec: Math.round(repairRun.ms / 1000),
              toolCalls: repairRun.toolCalls,
              subagents: repairRun.subagents,
              repairs: 1,
              valid: false,
              notes: repairRun.errorMessage ?? "no walkthrough in quality-repair output",
            });
            if (walkthrough.meta.run && qualityCost > 0) {
              walkthrough.meta.run = {
                ...walkthrough.meta.run,
                costUsd: repairRun.sessionCost,
                repairs: (walkthrough.meta.run.repairs ?? 0) + 1,
              };
              qualityFoldedIntoMeta = true;
            }
          }
        } catch (err) {
          console.warn(
            "[analyze-pipeline] quality repair failed:",
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    emit({ kind: "stage", t: elapsed(), stage: "saving", label: "Saving the walkthrough" });
    await saveWalkthrough(walkthrough);
    let qualityWarnings = checkQuality(walkthrough);

    let verifierCost = 0;
    let reviseCost = 0;
    let reviseFoldedIntoMeta = false;

    if (process.env.VERIFY_SHOTS !== "0" && canVerify(walkthrough.pr.repo)) {
      const shotGate = shouldAttemptShots(walkthrough);
      if (!shotGate.attempt) {
        walkthrough.verification = {
          status: "skipped",
          scenario: walkthrough.verification?.scenario ?? [],
          skipReason: shotGate.reason,
        };
        await saveWalkthrough(walkthrough);
        emit({
          kind: "stage",
          t: elapsed(),
          stage: "shots",
          label: `Screenshots skipped: ${shotGate.reason.slice(0, 120)}`,
        });
      } else {
        const verifierEvents = createProgressNormalizer(started, emit);
        try {
          const vr = await verifyShots({
            walkthrough,
            outDir: path.join(ROOT, "data/shots", owner, repo, String(number)),
            onStage: (stage, label) => emit({ kind: "stage", t: elapsed(), stage, label }),
            onEvent: (raw) => verifierEvents.handle(raw, Date.now()),
          });
          verifierCost = vr.costUsd;
          if (vr.status === "ok") {
            walkthrough.shots = vr.shots;
            if (vr.symptomSrcs && vr.symptomSrcs.size > 0) {
              attachSymptomShots(walkthrough, vr.symptomSrcs);
              emit({
                kind: "stage",
                t: elapsed(),
                stage: "shots",
                label: `Attached ${vr.symptomSrcs.size} per-symptom screenshot(s)`,
              });
            }
            await saveWalkthrough(walkthrough);
            emit({ kind: "stage", t: elapsed(), stage: "shots", label: "Screenshots taken by Bob" });

            if (process.env.VERIFY_ABLATION !== "0") {
              const recipe = recipeFor(owner, repo);
              if (recipe && walkthrough.pr.baseSha) {
                emit({
                  kind: "stage",
                  t: elapsed(),
                  stage: "shots",
                  label: "Testing which changes fix the bug",
                });
                try {
                  const ablation = await runAblation({
                    mainPath: path.join(GIT_CACHE_DIR, `${owner}__${repo}`),
                    baseSha: walkthrough.pr.baseSha,
                    diff,
                    hunks: walkthrough.hunks,
                    skippedHunks: walkthrough.skippedHunks,
                    recipe,
                    reproPath: vr.reproPath,
                    onProgress: (msg) =>
                      emit({ kind: "stage", t: elapsed(), stage: "shots", label: msg }),
                  });
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

                  // Q1 — evidence-based revise when ablation contradicts claims.
                  if (process.env.VERIFY_REVISE !== "0") {
                    let measures: { base: unknown; head: unknown } | undefined;
                    try {
                      if (walkthrough.pr.headSha) {
                        const mainPath = path.join(GIT_CACHE_DIR, `${owner}__${repo}`);
                        const baseWt = await ensureWorktree(mainPath, walkthrough.pr.baseSha);
                        const headWt = await ensureWorktree(mainPath, walkthrough.pr.headSha);
                        const base = await startApp(recipe, baseWt);
                        const head = await startApp(recipe, headWt);
                        try {
                          const [b, h] = await Promise.all([
                            runRepro(vr.reproPath, base.url, ROOT),
                            runRepro(vr.reproPath, head.url, ROOT),
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
                    } catch (err) {
                      console.warn(
                        "[analyze-pipeline] could not re-measure BASE/HEAD for revise:",
                        err instanceof Error ? err.message : err
                      );
                    }

                    emit({
                      kind: "stage",
                      t: elapsed(),
                      stage: "repairing",
                      label: "Revising the explanation from measured evidence",
                    });
                    const reviseEvents = createProgressNormalizer(started, emit);
                    try {
                      const revised = await reviseFromAblation({
                        walkthrough,
                        ablation,
                        repoPath: workspace.repoPath,
                        diff,
                        measures,
                        prLabel: `${owner}/${repo}#${number}`,
                        onEvent: (raw) => reviseEvents.handle(raw, Date.now()),
                      });
                      if (revised.status === "ok") {
                        reviseCost = revised.costUsd;
                        reviseFoldedIntoMeta = true;
                        walkthrough = revised.walkthrough;
                        await saveWalkthrough(walkthrough);
                        qualityWarnings = checkQuality(walkthrough);
                        emit({
                          kind: "stage",
                          t: elapsed(),
                          stage: "repairing",
                          label: "Explanation revised to match measured evidence",
                        });
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
                } catch (err) {
                  console.warn(
                    "[analyze-pipeline] ablation failed:",
                    err instanceof Error ? err.message : err
                  );
                }
              }
            }
          } else {
            emit({
              kind: "stage",
              t: elapsed(),
              stage: "shots",
              label: `Screenshots skipped: ${vr.reason}`,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("[analyze-pipeline] screenshot verifier failed:", message);
          emit({
            kind: "stage",
            t: elapsed(),
            stage: "shots",
            label: `Screenshots failed: ${message.slice(0, 160)}`,
          });
        }
      }
    }

    // Successful quality/revise resumes fold their spend into meta.run.costUsd
    // (Bob's cumulative task total). Failed ones still spent — add the increment.
    // Verifier is a separate Bob task, always additive.
    const run = walkthrough.meta.run;
    const orphanResumeCost =
      (qualityFoldedIntoMeta ? 0 : qualityCost) + (reviseFoldedIntoMeta ? 0 : reviseCost);
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
    const message = err instanceof Error ? err.message : String(err);
    emit({ kind: "error", t: elapsed(), message });
    failJob(jobId, message);
  } finally {
    if (analyzerType === "bob" && progressLog.length > 0) {
      try {
        const stamp = new Date(started).toISOString().replace(/[:.]/g, "-");
        const runDir = path.join(ROOT, "data/runs", `${stamp}-${repo}-${number}-live`);
        await mkdir(runDir, { recursive: true });
        await writeFile(
          path.join(runDir, "progress.ndjson"),
          progressLog.map((e) => JSON.stringify(e)).join("\n") + "\n"
        );
      } catch (err) {
        console.warn("[analyze-pipeline] could not persist progress.ndjson (best effort):", err);
      }
    }
  }
}
