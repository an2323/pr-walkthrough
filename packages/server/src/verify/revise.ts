/**
 * revise.ts — ST12-E / Q1: resume the original analysis session and rewrite
 * only the steps the ablation table contradicts. Shared by the live analyze
 * pipeline and `scripts/bob-revise.ts`.
 *
 * Never overwrites a good walkthrough with a broken revise: the caller gets
 * `{ status: "failed" }` and keeps the previous draft.
 */

import { execFile } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Ablation, Step, Walkthrough } from "@pr-walkthrough/shared";

import type { AnalyzerInput } from "../analyzer/interface.js";
import {
  findWalkthroughInEvents,
  normalizeDraft,
  repairBob,
  runBob,
} from "../analyzer/bob-shell.js";
import { assertBudget, recordSpend } from "../analyzer/budget.js";
import type { RepoWorkspace } from "../git/workspace.js";
import { validate } from "../validation/index.js";
import { verdictForStep } from "./ablation.js";

const execFileAsync = promisify(execFile);

const REVISE_MAX_COST = Number(process.env.REVISE_MAX_COST ?? 1);

export function formatAblation(a: Ablation): string {
  const titles = new Map((a.scenarios ?? []).map((s) => [s.id, s.title]));
  const lines = a.runs.flatMap((r) => {
    const head = `${r.mode === "alone" ? "ONLY" : "EVERYTHING EXCEPT"} [${r.unitIds.join(", ")}]`;
    if (r.results?.length) {
      // One line per scenario: each is a separate user-visible behaviour, measured on the same build.
      return r.results.map(
        (x) => `- ${head} → ${x.verdict} for "${titles.get(x.scenarioId) ?? x.scenarioId}"` + (x.detail ? ` (${x.detail.slice(0, 120)})` : "")
      );
    }
    const only = a.scenarios?.[0];
    return [`- ${head} → ${r.verdict}${only ? ` for "${only.title}"` : ""}` + (r.detail ? ` (${r.detail.slice(0, 120)})` : "")];
  });
  const scen = a.scenarios?.length
    ? `\nScenarios measured (each a separate behaviour a user sees):\n${a.scenarios.map((s) => `- "${s.title}"`).join("\n")}\nA hunk that matters for only ONE of them is still required for the PR — "no effect" is only true if it changed NOTHING in any scenario.`
    : "";
  return `Hunks tested: ${a.units.join(", ")}${scen}\n${lines.join("\n")}`;
}

/**
 * Whether measured ablation contradicts the walkthrough's claims enough to
 * warrant a paid revise pass. Biased toward revising when signals conflict
 * (quality-first); `not-separable` alone is not enough.
 */
export function ablationContradictsWalkthrough(wt: Walkthrough, ablation: Ablation): boolean {
  for (const step of wt.steps) {
    const verdict = verdictForStep(ablation, step.hunkIds);
    if (!verdict || verdict === "not-separable") continue;

    const claim = `${step.headline ?? ""} ${step.say ?? ""} ${step.title}`;

    // Required for the fix but presented as minor / optional.
    if (verdict === "needed" && step.minor) return true;
    if (verdict === "needed" && /\b(minor|optional|incidental|cleanup|not required|unrelated)\b/i.test(claim)) {
      return true;
    }

    // Measured no-effect but still a non-minor change/cause/decision claiming impact.
    if (verdict === "no-effect" && !step.minor) {
      if (step.kind === "change" || step.kind === "cause" || step.kind === "decision") return true;
      if (/\b(fix(?:es)?|required|necessary|causes?|because|critical|essential)\b/i.test(claim)) {
        return true;
      }
    }
  }
  return false;
}

export function buildRevisePrompt(
  wt: Walkthrough,
  ablation: Ablation,
  measures?: { base: unknown; head: unknown }
): string {
  const stepClaims = wt.steps
    .filter((s) => !s.minor)
    .map(
      (s) =>
        `${s.id} [hunks: ${s.hunkIds.join(", ") || "none"}]: "${s.headline ?? s.title}" — ${s.say ?? ""}`
    )
    .join("\n");

  return `Evidence-based correction. Your walkthrough's steps make causal claims about which code
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
- The measurement covers ONE scenario (the behaviour the repro script checks) — usually just one of
  the PR's effects. Whenever you state what a change fixes or is sufficient for, name THAT behaviour in
  plain words ("fixes the toolbar covering the panel on its own"). Never write "the bug" or "the
  problem" as if the PR had a single one when other effects of the PR were not measured, and never let
  a headline claim more than the measured scenario shows.
- \`say\` and \`notes\` may cite the evidence ("confirmed by testing this change on its own", a value
  from the measurement, etc.) — that is what they are for. \`narration\` must NEVER mention the
  ablation, the measurement, or how any claim was checked — no "ablation", "confirms", "the
  measurement shows", or similar. It is a plain, spoken explanation of the change itself, exactly like
  every other step's narration; rewrite it to state the (now evidence-backed) conclusion directly, the
  same way you would if you had simply known it from the start.
Leave every step the evidence does NOT contradict exactly as it is.

Return the COMPLETE corrected JSON object again — same rules as the original analysis: no prose, no
markdown fence, omit hunks/coverage/pr.`;
}

/** $0 stitch fix: insert an elided line where the validator reported a gap. */
const STITCH = /^step (\S+) beat (\d+) block (\d+) line (\d+):/;

export function tryMechanicalStitchFix(draft: Record<string, unknown>, errors: string[]): boolean {
  if (errors.length === 0 || !errors.every((e) => STITCH.test(e))) return false;
  const stepsById = new Map((draft.steps as { id: string }[]).map((s) => [s.id, s]));
  const sorted = [...errors].sort((a, b) => Number(STITCH.exec(b)![4]) - Number(STITCH.exec(a)![4]));
  for (const e of sorted) {
    const [, stepId, bi, ci, li] = STITCH.exec(e)!;
    const step = stepsById.get(stepId) as
      | { beats: { code?: { lines: { kind: string; text: string }[] }[] }[] }
      | undefined;
    const lines = step?.beats?.[Number(bi)]?.code?.[Number(ci)]?.lines;
    if (!lines) return false;
    lines.splice(Number(li), 0, { kind: "elided", text: "…" });
  }
  return true;
}

function rederiveEvidence(wt: Walkthrough, ablation: Ablation): void {
  for (const step of wt.steps) {
    const verdict = verdictForStep(ablation, step.hunkIds);
    if (verdict) step.evidence = { source: "ablation", verdict };
  }
}

export type ReviseResult =
  | { status: "ok"; walkthrough: Walkthrough; costUsd: number; repairs: number }
  | { status: "skipped"; reason: string; costUsd: number }
  | { status: "failed"; reason: string; costUsd: number };

export interface ReviseOpts {
  walkthrough: Walkthrough;
  ablation: Ablation;
  /** Workspace already prepared at HEAD (same path Bob analyzed). */
  repoPath: string;
  diff: string;
  measures?: { base: unknown; head: unknown };
  /** Force revise even when `ablationContradictsWalkthrough` is false (CLI). */
  force?: boolean;
  onEvent?: (raw: unknown) => void;
  /** PR label for the cost log, e.g. `excalidraw/excalidraw#10943`. */
  prLabel?: string;
}

/**
 * Resume the analysis task and revise contradicted steps. Returns the previous
 * walkthrough unchanged semantics via `failed`/`skipped` — caller must not save
 * over the good draft unless `status === "ok"`.
 */
export async function reviseFromAblation(opts: ReviseOpts): Promise<ReviseResult> {
  const wt = opts.walkthrough;
  const ablation = opts.ablation;
  const taskId = wt.meta.run?.taskId;
  if (!taskId) {
    return { status: "skipped", reason: "no meta.run.taskId — nothing to resume", costUsd: 0 };
  }
  if (!wt.pr.baseSha || !wt.pr.headSha) {
    return { status: "skipped", reason: "walkthrough has no base/head SHA", costUsd: 0 };
  }
  if (!opts.force && !ablationContradictsWalkthrough(wt, ablation)) {
    return { status: "skipped", reason: "ablation does not contradict step claims", costUsd: 0 };
  }

  const previousCost = wt.meta.run?.costUsd ?? 0;
  const cumulativeCap = (previousCost + REVISE_MAX_COST).toFixed(2);
  await assertBudget(REVISE_MAX_COST);

  const prompt = buildRevisePrompt(wt, ablation, opts.measures);
  const run = await runBob(prompt, opts.repoPath, cumulativeCap, {
    resumeTaskId: taskId,
    onEvent: opts.onEvent,
  });
  const increment = Math.max(0, run.sessionCost - previousCost);
  const prLabel = opts.prLabel ?? `${wt.pr.repo}#${wt.pr.number}`;

  const draftRaw = findWalkthroughInEvents(run.events);
  if (!draftRaw) {
    await recordSpend({
      pr: prLabel,
      mode: "revise",
      maxCost: REVISE_MAX_COST,
      actualCost: increment,
      durationSec: Math.round(run.ms / 1000),
      toolCalls: run.toolCalls,
      subagents: run.subagents,
      repairs: 0,
      valid: false,
      notes: run.errorMessage ?? "no JSON found in response",
    });
    return {
      status: "failed",
      reason: run.errorMessage ?? "no walkthrough JSON found in Bob's response",
      costUsd: increment,
    };
  }

  normalizeDraft(draftRaw);
  let currentDraft = draftRaw;

  const ws: RepoWorkspace = {
    repoPath: opts.repoPath,
    baseSha: wt.pr.baseSha,
    headSha: wt.pr.headSha,
    readFile: (file, rev) =>
      rev === "base"
        ? execFileAsync("git", ["show", `${wt.pr.baseSha}:${file}`], {
            cwd: opts.repoPath,
            maxBuffer: 16 * 1024 * 1024,
          }).then((r) => r.stdout)
        : fsReadFile(path.join(opts.repoPath, file), "utf-8"),
    diff: async () => opts.diff,
  };
  const input: AnalyzerInput = {
    repoPath: opts.repoPath,
    baseSha: wt.pr.baseSha,
    headSha: wt.pr.headSha,
    pr: wt.pr,
    hunks: wt.hunks,
    diff: opts.diff,
  };

  let result = await validate({ ...currentDraft, pr: wt.pr } as unknown as Walkthrough, input, ws);
  let totalCost = run.sessionCost;
  let repairs = 0;
  let mechanicalFix = false;

  if (!result.valid && tryMechanicalStitchFix(currentDraft, result.errors)) {
    mechanicalFix = true;
    result = await validate({ ...currentDraft, pr: wt.pr } as unknown as Walkthrough, input, ws);
  }

  if (!result.valid) {
    const repairCap = (totalCost + REVISE_MAX_COST).toFixed(2);
    await assertBudget(REVISE_MAX_COST);
    const repairRun = await repairBob(
      taskId,
      result.errors.slice(0, 20),
      opts.repoPath,
      repairCap,
      opts.onEvent
    );
    repairs = 1;
    totalCost = repairRun.sessionCost;
    const repairedRaw = findWalkthroughInEvents(repairRun.events);
    if (repairedRaw) {
      normalizeDraft(repairedRaw);
      currentDraft = repairedRaw;
      result = await validate({ ...repairedRaw, pr: wt.pr } as unknown as Walkthrough, input, ws);
      if (!result.valid && tryMechanicalStitchFix(currentDraft, result.errors)) {
        mechanicalFix = true;
        result = await validate({ ...currentDraft, pr: wt.pr } as unknown as Walkthrough, input, ws);
      }
    }
  }

  const costUsd = Math.max(0, totalCost - previousCost);
  await recordSpend({
    pr: prLabel,
    mode: "revise",
    maxCost: REVISE_MAX_COST * (1 + repairs),
    actualCost: costUsd,
    durationSec: Math.round(run.ms / 1000),
    toolCalls: run.toolCalls,
    subagents: run.subagents,
    repairs,
    valid: result.valid,
    notes: result.valid
      ? `revised from ablation evidence${mechanicalFix ? " (+ mechanical elided-line fix)" : ""}`
      : result.errors.slice(0, 3).join("; "),
  });

  if (!result.valid || !result.walkthrough) {
    return {
      status: "failed",
      reason: result.errors.slice(0, 5).join("; ") || "revise failed validation",
      costUsd,
    };
  }

  result.walkthrough.shots = wt.shots;
  result.walkthrough.verification = wt.verification;
  rederiveEvidence(result.walkthrough, ablation);
  result.walkthrough.meta.run = {
    costUsd: totalCost,
    maxCostUsd: Number(cumulativeCap) + (repairs ? REVISE_MAX_COST : 0),
    durationMs: (wt.meta.run?.durationMs ?? 0) + run.ms,
    toolCalls: (wt.meta.run?.toolCalls ?? 0) + run.toolCalls,
    subagents: Math.max(wt.meta.run?.subagents ?? 0, run.subagents),
    repairs: (wt.meta.run?.repairs ?? 0) + 1 + repairs,
    taskId,
  };

  return { status: "ok", walkthrough: result.walkthrough, costUsd, repairs };
}

/** Steps whose ablation verdict is set (for tests / logging). */
export function stepsWithAblationVerdict(wt: Walkthrough, ablation: Ablation): Array<{ step: Step; verdict: string }> {
  const out: Array<{ step: Step; verdict: string }> = [];
  for (const step of wt.steps) {
    const verdict = verdictForStep(ablation, step.hunkIds);
    if (verdict) out.push({ step, verdict });
  }
  return out;
}
