/**
 * progress-events.ts — builders for the structured progress events the analysis screen draws from
 * (plan, files, scenario, outcome, frames). Pure functions, so the wording and the classification
 * are testable without running the pipeline.
 */

import type { Hunk, ProgressEvent, ProgressEventOf, ShotsOutcomeCode, SkippedHunk } from "@pr-walkthrough/shared";

import { IDENTICAL_FRAMES_NOTE, NO_FRAMES_NOTE, plainNoShotsReason, shotsOutcomeCode } from "../verify/shots-status.js";

type Emit = (e: ProgressEvent) => void;

/** Why screenshots are not planned for this repository, in a sentence — or undefined when they are. */
export function shotsNotPlannedReason(canVerifyRepo: boolean, verifyShotsOff: boolean, repoFullName: string): string | undefined {
  if (verifyShotsOff) return plainNoShotsReason("screenshots turned off (VERIFY_SHOTS=0)");
  if (!canVerifyRepo) return plainNoShotsReason(`no app recipe for ${repoFullName}`);
  return undefined;
}

/** Ablation builds per changed unit: each alone + all but it; units are capped (verify/ablation.ts). */
const MAX_ABLATION_UNITS = 5;

/**
 * Minutes a run will take, from our own runs (Sep 29–30): analysis 2–5, a cold app install 3–5
 * (warm ≈1), app start 1–1.5, the screenshot verifier 2–5 incl. a repair, ablation ~45–60 s per
 * build, fact check 0.5–1.5, narration 0.3–1. #12053 cold, 10 builds: 21 min; #10295 warm: 18.
 */
export function estimateRun(o: { shotsPlanned: boolean; ablationUnits: number; coldInstall: boolean; voice: boolean }): {
  minMinutes: number;
  maxMinutes: number;
  ablationBuilds: number;
  coldInstall: boolean;
} {
  let lo = 2;
  let hi = 5;
  let builds = 0;
  if (o.shotsPlanned) {
    lo += o.coldInstall ? 3 : 0.5;
    hi += o.coldInstall ? 5 : 1;
    lo += 1 + 2 + 0.5; // app start, verifier, fact check
    hi += 1.5 + 5 + 1.5;
    builds = o.ablationUnits >= 2 ? 2 * Math.min(o.ablationUnits, MAX_ABLATION_UNITS) : 0;
    lo += builds * 0.75;
    hi += builds;
  }
  if (o.voice) {
    lo += 0.3;
    hi += 1;
  }
  return { minMinutes: Math.round(lo), maxMinutes: Math.ceil(hi), ablationBuilds: builds, coldInstall: o.shotsPlanned && o.coldInstall };
}

export function planEvent(
  t: number,
  pr: { title: string; additions: number; deletions: number; filesChanged: number },
  notPlannedReason: string | undefined,
  extra: { voice?: boolean; estimate?: ReturnType<typeof estimateRun> } = {}
): ProgressEventOf<"plan"> {
  return {
    kind: "plan",
    t,
    pr: { title: pr.title, additions: pr.additions, deletions: pr.deletions, files: pr.filesChanged },
    shots: notPlannedReason === undefined ? { planned: true } : { planned: false, reason: notPlannedReason },
    ...(extra.voice !== undefined ? { voice: { planned: extra.voice } } : {}),
    ...(extra.estimate ? { estimate: extra.estimate } : {}),
  };
}

/** One row per changed file; a file is `skipped` when every hunk in it was hidden from Bob as mechanical. */
export function filesEvent(t: number, hunks: Hunk[], skipped: SkippedHunk[]): ProgressEventOf<"files"> {
  const skippedIds = new Set(skipped.map((s) => s.hunkId));
  const byFile = new Map<string, { additions: number; deletions: number; hunks: number; skipped: number }>();
  for (const h of hunks) {
    const row = byFile.get(h.file) ?? { additions: 0, deletions: 0, hunks: 0, skipped: 0 };
    row.additions += h.added;
    row.deletions += h.removed;
    row.hunks += 1;
    if (skippedIds.has(h.id)) row.skipped += 1;
    byFile.set(h.file, row);
  }
  return {
    kind: "files",
    t,
    files: [...byFile].map(([path, r]) => ({ path, additions: r.additions, deletions: r.deletions, skipped: r.skipped === r.hunks })),
  };
}

export function scenarioEvent(t: number, lines: string[] | undefined): ProgressEventOf<"scenario"> | undefined {
  const clean = (lines ?? []).map((l) => l.trim()).filter(Boolean);
  return clean.length > 0 ? { kind: "scenario", t, lines: clean } : undefined;
}

export function outcomeEvent(t: number, code: ShotsOutcomeCode, message: string): ProgressEventOf<"outcome"> {
  return { kind: "outcome", t, what: "shots", code, message };
}

/** The screenshot stage was skipped or failed for a reason string from the verifier (raw or already plain). */
export function skippedOutcome(t: number, reason: string, opts: { alreadyPlain?: boolean } = {}): ProgressEventOf<"outcome"> {
  return outcomeEvent(t, shotsOutcomeCode(reason), opts.alreadyPlain ? reason : plainNoShotsReason(reason));
}

/** The repro was confirmed: frames exist, or (shotsNote) it is proven but a still can't show it. */
export function confirmedEvents(
  t: number,
  shots: { before: { src: string }; after: { src: string }; caption?: string } | undefined,
  shotsNote: string | undefined
): ProgressEvent[] {
  if (shots) {
    return [
      { kind: "frames", t, before: shots.before.src, after: shots.after.src, ...(shots.caption ? { caption: shots.caption } : {}) },
      outcomeEvent(t, "ok", "The bug reproduced at the old commit and is gone at the new one."),
    ];
  }
  return [outcomeEvent(t, "identical", shotsNote ?? NO_FRAMES_NOTE)];
}

/** Convenience: emit several events in order. */
export function emitAll(emit: Emit, events: (ProgressEvent | undefined)[]): void {
  for (const e of events) if (e) emit(e);
}

export { IDENTICAL_FRAMES_NOTE };
