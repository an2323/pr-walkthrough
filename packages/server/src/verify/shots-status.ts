/**
 * shots-status.ts — say honestly, in plain words, why a walkthrough has no
 * before/after screenshots. Screenshots are an optional extra: many PRs have
 * nothing to see, most repos have no app recipe, and the capture itself can
 * fail. In every one of those cases the reader should learn which it was —
 * never a silent gap, and never an internal error string.
 */

import type { ShotsOutcomeCode, Walkthrough } from "@pr-walkthrough/shared";

export const IDENTICAL_FRAMES_NOTE =
  "The bug was reproduced in the running app, but before and after look the same in a still image — the difference is in behaviour, not in pixels.";

export const NO_FRAMES_NOTE =
  "The bug was reproduced in the running app, but no screenshots came out of that run.";

const MAX_REASON = 220;

/** Map an internal skip/failure reason to a sentence a reviewer can read. */
export function plainNoShotsReason(raw: string): string {
  const r = raw.trim();
  if (/no app recipe/i.test(r)) {
    return "this repository isn't set up for automatic screenshots.";
  }
  if (/turned off|VERIFY_SHOTS/i.test(r)) {
    return "automatic screenshots are turned off on this server.";
  }
  if (/non-visual change/i.test(r)) {
    return "this looks like a change with nothing to see in the running app.";
  }
  if (/base\/head sha/i.test(r)) {
    return "the exact commits to compare weren't available.";
  }
  if (/no credits left/i.test(r)) {
    return "the screenshot tool is out of credits right now.";
  }
  if (/screenshot tool|BOB_API_KEY/i.test(r)) {
    return "the screenshot tool isn't available on this server.";
  }
  if (/warm-up|dev server|didn't start|could not start|timed out waiting|install failed|only [\d.]+ GB free|\b(yarn|npm|pnpm)\b[^:]*\b(exited|timed out)\b/i.test(r)) {
    return "the app couldn't be started here, so no screenshots are shown.";
  }
  if (/repro|not trusted|did not write|could not|couldn't|failed|error|timed? ?out|browser|install/i.test(r)) {
    return "the bug couldn't be reproduced reliably in the running app, so no screenshots are shown.";
  }
  // Anything else is a reason the verifier itself wrote in plain words (skip.json).
  return r.length > MAX_REASON ? `${r.slice(0, MAX_REASON - 1).trimEnd()}…` : r;
}

/**
 * The machine-readable twin of plainNoShotsReason: which kind of ending was it? Same patterns, same order,
 * so the progress screen can pick the right card without parsing the sentence. A reason the verifier wrote in
 * plain words itself (it declined: "only affects server-side rendering") means there was nothing to see.
 */
export function shotsOutcomeCode(raw: string): ShotsOutcomeCode {
  const r = raw.trim();
  if (/no app recipe/i.test(r)) return "no-recipe";
  if (/turned off|VERIFY_SHOTS/i.test(r)) return "unavailable";
  if (/non-visual change/i.test(r)) return "non-visual";
  if (/base\/head sha/i.test(r)) return "unavailable";
  if (/no credits left/i.test(r)) return "unavailable";
  if (/screenshot tool|BOB_API_KEY/i.test(r)) return "unavailable";
  if (/warm-up|dev server|didn't start|could not start|timed out waiting|install failed|only [\d.]+ GB free|\b(yarn|npm|pnpm)\b[^:]*\b(exited|timed out)\b/i.test(r)) return "app-failed";
  if (/repro|not trusted|did not write|could not|couldn't|failed|error|timed? ?out|browser|install/i.test(r)) return "not-reproduced";
  return "non-visual";
}

/** Record on the walkthrough that no before/after screenshots exist, and why. Never throws. */
export function recordNoShots(
  wt: Walkthrough,
  reason: string,
  opts: { alreadyPlain?: boolean } = {}
): void {
  wt.verification = {
    ...wt.verification,
    status: "skipped",
    scenario: wt.verification?.scenario ?? [],
    skipReason: opts.alreadyPlain ? reason : plainNoShotsReason(reason),
  };
}

/** The repro worked but there is no picture to show — keep the measured status, add the note. */
export function recordShotsNote(wt: Walkthrough, note: string): void {
  wt.verification = {
    ...wt.verification,
    status: wt.verification?.status ?? "not_run",
    scenario: wt.verification?.scenario ?? [],
    shotsNote: note,
  };
}

/**
 * The verifier's repro was confirmed (true at BASE, false at HEAD): that IS the fix verified, so
 * the status is "passed" — and any earlier "no screenshots" placeholder reason no longer applies.
 */
export function markVerified(wt: Walkthrough): void {
  const { skipReason: _stale, ...rest } = wt.verification ?? { status: "not_run" as const, scenario: [] };
  wt.verification = { ...rest, status: "passed", scenario: wt.verification?.scenario ?? [] };
}
