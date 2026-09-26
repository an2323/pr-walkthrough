/**
 * analyze-pipeline.ts — runs one PR analysis in the background and reports
 * progress through the job store (jobs.ts). This is the async counterpart of
 * the old synchronous `POST /api/analyze` handler: same steps (fetch meta →
 * prepare workspace → parse hunks → analyze → validate → save → quality
 * check), instrumented with `ProgressEvent`s instead of only `console.log`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseHunks, type ProgressEvent } from "@pr-walkthrough/shared";

import { emitProgress, completeJob, failJob } from "./jobs.js";
import { fetchPRMeta } from "../github/client.js";
import { prepareWorkspace } from "../git/workspace.js";
import { createAnalyzer, CachedAnalyzer } from "../analyzer/index.js";
import { classifyHunks } from "../analyzer/classify-hunks.js";
import { createProgressNormalizer } from "../analyzer/progress-normalizer.js";
import { canVerify, verifyShots } from "../verify/bob-verifier.js";
import { runAblation, verdictForStep } from "../verify/ablation.js";
import { recipeFor } from "../verify/recipes.js";
import { validate, checkQuality } from "../validation/index.js";
import { loadWalkthrough, saveWalkthrough } from "../storage.js";

const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
// Repo root = 4 levels up from packages/server/src/api/
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

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
      await cached.analyze(minimalInput); // throws with a clear message if not cached
      emit({ kind: "done", t: elapsed(), walkthroughUrl, durationMs: elapsed() });
      completeJob(jobId, { walkthroughUrl });
      return;
    }

    // ------------------------------------------------------------------
    // bob mode — full pipeline
    // ------------------------------------------------------------------
    // Already analysed → serve it instead of paying for a new run, unless the
    // caller explicitly asked to re-analyse ({ force: true }).
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
    const { skipped } = classifyHunks(hunks); // same classification BobShellAnalyzer applies — just for the stage label here.

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
    const result = await validate(draft, input, workspace);
    if (!result.valid || !result.walkthrough) {
      const message = `Validation failed: ${result.errors.slice(0, 3).join("; ")}`;
      emit({ kind: "error", t: elapsed(), message });
      failJob(jobId, message);
      return;
    }

    emit({ kind: "stage", t: elapsed(), stage: "saving", label: "Saving the walkthrough" });
    await saveWalkthrough(result.walkthrough);
    const qualityWarnings = checkQuality(result.walkthrough);

    // Before/after screenshots (ST6e) — only for repos with an app recipe, and
    // never fatal: the walkthrough is already saved and viewable without them.
    let verifierCost = 0;
    if (process.env.VERIFY_SHOTS !== "0" && canVerify(result.walkthrough.pr.repo)) {
      const verifierEvents = createProgressNormalizer(started, emit);
      try {
        const vr = await verifyShots({
          walkthrough: result.walkthrough,
          outDir: path.join(ROOT, "data/shots", owner, repo, String(number)),
          onStage: (stage, label) => emit({ kind: "stage", t: elapsed(), stage, label }),
          onEvent: (raw) => verifierEvents.handle(raw, Date.now()),
        });
        verifierCost = vr.costUsd;
        if (vr.status === "ok") {
          result.walkthrough.shots = vr.shots;
          await saveWalkthrough(result.walkthrough);
          emit({ kind: "stage", t: elapsed(), stage: "shots", label: "Screenshots taken by Bob" });

          // ST12-D: now that the repro script is CONFIRMED (true@BASE, false@HEAD —
          // see bob-verifier.ts), measure which hunks the fix actually needs instead
          // of trusting the analyzer's own account of it. $0, no Bob involved.
          if (process.env.VERIFY_ABLATION !== "0") {
            const recipe = recipeFor(owner, repo);
            if (recipe && result.walkthrough.pr.baseSha) {
              emit({ kind: "stage", t: elapsed(), stage: "shots", label: "Testing which changes fix the bug" });
              try {
                const ablation = await runAblation({
                  mainPath: path.join(GIT_CACHE_DIR, `${owner}__${repo}`),
                  baseSha: result.walkthrough.pr.baseSha,
                  diff,
                  hunks: result.walkthrough.hunks,
                  skippedHunks: result.walkthrough.skippedHunks,
                  recipe,
                  reproPath: vr.reproPath,
                  onProgress: (msg) => emit({ kind: "stage", t: elapsed(), stage: "shots", label: msg }),
                });
                result.walkthrough.verification = { ...result.walkthrough.verification, status: "passed", scenario: result.walkthrough.verification?.scenario ?? [], ablation };
                for (const step of result.walkthrough.steps) {
                  const verdict = verdictForStep(ablation, step.hunkIds);
                  if (verdict) step.evidence = { source: "ablation", verdict };
                }
                await saveWalkthrough(result.walkthrough);
                emit({ kind: "stage", t: elapsed(), stage: "shots", label: `Measured ${ablation.units.length} change(s) against the running app` });
              } catch (err) {
                console.warn("[analyze-pipeline] ablation failed:", err instanceof Error ? err.message : err);
              }
            }
          }
        } else {
          emit({ kind: "stage", t: elapsed(), stage: "shots", label: `Screenshots skipped: ${vr.reason}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[analyze-pipeline] screenshot verifier failed:", message);
        emit({ kind: "stage", t: elapsed(), stage: "shots", label: `Screenshots failed: ${message.slice(0, 160)}` });
      }
    }

    // Cost/tool/subagent totals come from BobShellAnalyzer's own accounting
    // (draft.meta.run — it tracks the cumulative task across a repair, which
    // the raw event stream alone can't tell us), not re-derived here.
    const run = (draft as unknown as { meta?: { run?: { costUsd?: number; toolCalls?: number; subagents?: number } } })
      .meta?.run;
    emit({
      kind: "done",
      t: elapsed(),
      walkthroughUrl,
      durationMs: elapsed(),
      costUsd: run?.costUsd !== undefined ? run.costUsd + verifierCost : undefined,
      toolCalls: run?.toolCalls,
      subagents: run?.subagents,
    });
    completeJob(jobId, { walkthroughUrl, qualityWarnings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ kind: "error", t: elapsed(), message });
    failJob(jobId, message);
  } finally {
    // Best-effort recording of the normalized progress stream, alongside the
    // Bob Shell run's own raw event recording — never fails the job.
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
