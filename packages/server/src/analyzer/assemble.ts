/**
 * assemble.ts — the fields the BACKEND owns on a walkthrough, applied the same way to every
 * draft Bob returns: the first analysis, a schema repair, a quality repair and a revise.
 *
 * Bob never sees the auto-skipped mechanical hunks, the screenshot paths or the ablation
 * verdicts, so any JSON it rewrites comes back without them. Two live bugs came from a stage
 * that forgot one of these (a quality repair that failed coverage because the auto-skipped
 * hunks were gone; a revise whose rewrite dropped the symptom frames). Every stage that
 * replaces the walkthrough goes through here instead of patching fields by hand.
 */

import type { Ablation, PullRequestMeta, Walkthrough } from "@pr-walkthrough/shared";

import { classifyHunks } from "./classify-hunks.js";
import { normalizeDraft } from "./bob-shell.js";
import { verdictForStep } from "../verify/ablation.js";
import { attachSymptomShots } from "../verify/symptom-shots.js";

/**
 * Normalize a raw draft from Bob and put back what the backend adds before validation:
 * `pr`, and the mechanical hunks (tests, lockfiles, …) that were never in Bob's prompt.
 * Mutates and returns `draft`.
 */
export function assembleDraft(
  draft: Record<string, unknown>,
  pr: PullRequestMeta,
  hunks: Walkthrough["hunks"]
): Record<string, unknown> {
  normalizeDraft(draft);
  const { skipped } = classifyHunks(hunks);
  if (skipped.length > 0) {
    const existing = (draft.skippedHunks as { hunkId: string; reason: string }[] | undefined) ?? [];
    const have = new Set(existing.map((s) => s.hunkId));
    draft.skippedHunks = [...existing, ...skipped.filter((s) => !have.has(s.hunkId))];
  }
  draft.pr = pr;
  return draft;
}

/** Evidence the backend measured or captured; none of it comes from Bob's text. */
export interface BackendEvidence {
  shots?: Walkthrough["shots"];
  verification?: Walkthrough["verification"];
  /** Per-symptom BASE frames, keyed by symptom index. */
  symptomSrcs?: ReadonlyMap<number, string>;
  ablation?: Ablation;
  /** Backend-written meta (analyzer, generatedAt, run stats) — Bob echoes whatever its example had. */
  meta?: Walkthrough["meta"];
}

/** Snapshot what `wt` currently carries that Bob can't reproduce. */
export function backendEvidenceOf(wt: Walkthrough, extra: Pick<BackendEvidence, "symptomSrcs"> = {}): BackendEvidence {
  return {
    shots: wt.shots,
    verification: wt.verification,
    ablation: wt.verification?.ablation,
    meta: wt.meta,
    ...extra,
  };
}

/**
 * Put the backend's evidence back onto a walkthrough Bob just rewrote. Mutates and returns `wt`.
 * `meta.run` is taken from `ev` with `keepRun`, otherwise the rewrite's own cumulative one wins
 * (revise builds a fresh one).
 */
export function carryBackendEvidence(wt: Walkthrough, ev: BackendEvidence, opts: { keepRun?: boolean } = {}): Walkthrough {
  if (ev.shots) wt.shots = ev.shots;
  else delete wt.shots;
  if (ev.verification) wt.verification = ev.verification;
  if (ev.symptomSrcs && ev.symptomSrcs.size > 0) attachSymptomShots(wt, ev.symptomSrcs);
  if (ev.ablation) {
    for (const step of wt.steps) {
      const verdict = verdictForStep(ev.ablation, step.hunkIds);
      if (verdict) step.evidence = { source: "ablation", verdict };
      else delete step.evidence;
    }
  }
  if (ev.meta) {
    const run = opts.keepRun ? ev.meta.run : (wt.meta?.run ?? ev.meta.run);
    wt.meta = { ...wt.meta, ...ev.meta, ...(run ? { run } : {}) };
  }
  return wt;
}
