/**
 * should-attempt-shots.ts — Q6: decide whether the screenshot/repro verifier
 * is worth running. When unsure, attempt (quality of evidence > skipping a
 * real UI bug). Skipping is only for strong non-visual signals.
 */

import type { Walkthrough } from "@pr-walkthrough/shared";

const NON_VISUAL_TITLE =
  /\b(perf|performance|optimis[ea]|optimiz|refactor|types?|chore|ci|deps?|dependency|bump|upgrade)\b/i;

/** Paths that often carry a visible UI change. */
const UI_FILE = /\.(scss|sass|css|less|tsx|jsx|vue|svelte)$/i;
const UI_DIR = /(^|\/)(components?|ui|styles?|css|themes?)(\/|$)/i;

export interface ShotAttemptDecision {
  attempt: boolean;
  reason: string;
}

function changedFiles(wt: Walkthrough): string[] {
  return [...new Set(wt.hunks.map((h) => h.file))];
}

function hasUiFiles(files: string[]): boolean {
  return files.some((f) => UI_FILE.test(f) || UI_DIR.test(f));
}

/**
 * Heuristic pre-check before spawning `pr-verifier`. Prefer false negatives
 * (still attempt) over false positives (skip a real visual bug).
 */
export function shouldAttemptShots(wt: Walkthrough): ShotAttemptDecision {
  const title = wt.plain?.title ?? wt.pr.title ?? "";
  const files = changedFiles(wt);
  const ui = hasUiFiles(files);

  if (NON_VISUAL_TITLE.test(title) && !ui) {
    return {
      attempt: false,
      reason: `title suggests a non-visual change (${title.slice(0, 80)}) and no UI files in the diff`,
    };
  }

  // Perf/refactor that still touches SCSS/TSX — might be visible; attempt.
  if (NON_VISUAL_TITLE.test(title) && ui) {
    return {
      attempt: true,
      reason: "title looks non-visual but the diff touches UI files — attempting screenshots",
    };
  }

  return { attempt: true, reason: "change may be visible in the running app" };
}
