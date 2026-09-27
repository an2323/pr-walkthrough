/**
 * quality.ts — soft checks against docs/output-contract.md. These are
 * WARNINGS, never hard failures: schema validity and verbatim-code checks
 * (schema.ts / verbatim.ts, orchestrated by index.ts) are what actually
 * blocks saving a walkthrough. This module answers "is it good", not
 * "is it valid".
 */

import type { Walkthrough } from "@pr-walkthrough/shared";

export interface QualityWarning {
  code: string;
  message: string;
  stepId?: string;
}

/**
 * Codes worth one automatic `--resume` repair (Q2). Soft style warnings
 * (length, step count, …) stay warnings only — they must not churn the draft.
 */
export const CRITICAL_QUALITY_CODES = new Set([
  "identifier-in-say",
  "identifier-in-headline",
  "identifier-in-narration",
  "identifier-in-plain",
  "narration-mentions-process",
]);

export function criticalQualityWarnings(warnings: QualityWarning[]): QualityWarning[] {
  return warnings.filter((w) => CRITICAL_QUALITY_CODES.has(w.code));
}

// ---------------------------------------------------------------------------
// "Does this look like an identifier / file name?" heuristics
// ---------------------------------------------------------------------------

const BACKTICK = /`[^`]+`/;
const CAMEL_OR_PASCAL = /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*\b/;
const CODE_FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|scss|css|json|py|go|rs|java|rb|kt|swift|yml|yaml|md)\b/i;
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/;
/** Narration must state a conclusion, never how it was checked (ST12's evidence loop). */
const PROCESS_WORDS = /\b(ablation|the measurement|measurement confirms|the backend (verified|confirmed)|verification confirms)\b/i;
const PATH_SEGMENT = /\b[\w.-]+\/[\w.-]+\b/;

/** Best-effort, deliberately over-eager — false positives are cheap for a warning a human reads. */
function looksLikeIdentifier(text: string): boolean {
  return (
    BACKTICK.test(text) ||
    CAMEL_OR_PASCAL.test(text) ||
    CODE_FILE_EXT.test(text) ||
    SNAKE_CASE.test(text) ||
    PATH_SEGMENT.test(text)
  );
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Step-count budget by PR size (docs/output-contract.md)
// ---------------------------------------------------------------------------

/**
 * Based on `coverage.explained` (hunks that actually earned a step), not the
 * raw hunk count — `skippedHunks` already removes mechanical noise, and this
 * avoids re-guessing which reasons count as "mechanical" from free text.
 * Each bucket's upper end has headroom for narrative steps that carry no
 * hunk at all (symptom, cause, decision, verification, a dead end) — a
 * reasoning chain naturally has a few of these beyond the hunks themselves.
 */
function stepBudget(explainedHunks: number): [min: number, max: number] {
  if (explainedHunks <= 5) return [3, 8];
  if (explainedHunks <= 50) return [5, 15];
  return [8, 18];
}

const TEST_FILE = /\.(test|spec)\.|__tests__|__snapshots__|\.snap$/i;

// ---------------------------------------------------------------------------
// checkQuality
// ---------------------------------------------------------------------------

export function checkQuality(walkthrough: Walkthrough): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  const warn = (code: string, message: string, stepId?: string): void => {
    warnings.push(stepId ? { code, message, stepId } : { code, message });
  };

  // --- plain-language layer: no identifiers ---
  if (walkthrough.plain) {
    const fields: [string, string][] = [
      ["plain.title", walkthrough.plain.title],
      ["plain.problem", walkthrough.plain.problem],
      ["plain.fix", walkthrough.plain.fix],
    ];
    for (const [field, text] of fields) {
      if (looksLikeIdentifier(text)) {
        warn("identifier-in-plain", `${field} looks like it contains an identifier or file name: "${text}"`);
      }
    }
  }

  // --- per-step checks ---
  for (const step of walkthrough.steps) {
    if (step.headline) {
      if (looksLikeIdentifier(step.headline)) {
        warn("identifier-in-headline", `Step ${step.id}'s headline looks like it contains an identifier or file name: "${step.headline}"`, step.id);
      }
      const words = wordCount(step.headline);
      if (words > 9) {
        warn("headline-too-long", `Step ${step.id}'s headline is ${words} words (limit 9): "${step.headline}"`, step.id);
      }
    }

    if (step.say) {
      if (looksLikeIdentifier(step.say)) {
        warn("identifier-in-say", `Step ${step.id}'s "say" looks like it contains an identifier or file name: "${step.say}"`, step.id);
      }
      const sentences = sentenceCount(step.say);
      if (sentences > 2) {
        warn("say-too-long", `Step ${step.id}'s "say" has ${sentences} sentences (should be one or two): "${step.say}"`, step.id);
      }
    }

    // Narration is read aloud by TTS: code names come out garbled, so the same
    // no-identifiers rule as `say` applies — and 2–4 sentences.
    if (step.narration) {
      if (looksLikeIdentifier(step.narration)) {
        warn("identifier-in-narration", `Step ${step.id}'s narration looks like it contains an identifier or file name — TTS will read it aloud: "${step.narration}"`, step.id);
      }
      const sentences = sentenceCount(step.narration);
      if (sentences > 4) {
        warn("narration-too-long", `Step ${step.id}'s narration has ${sentences} sentences (limit 4).`, step.id);
      }
      // ST12 evidence loop (bob-revise.ts): narration must read like every other
      // step's — the listener isn't told how a claim was checked.
      if (PROCESS_WORDS.test(step.narration)) {
        warn("narration-mentions-process", `Step ${step.id}'s narration mentions how a claim was checked (e.g. "ablation", "confirms") instead of just stating it: "${step.narration}"`, step.id);
      }
    }

    if (!step.minor && !step.visual && step.beats.some((b) => (b.traces ?? []).length > 0)) {
      warn("traces-without-visual", `Step ${step.id} has event traces but no \`visual\` — the reviewer sees the raw trace instead of a plain-words flow.`, step.id);
    }

    const hasCode = step.beats.some((b) => (b.code ?? []).length > 0);
    if (!step.minor && !hasCode && step.kind !== "symptom" && step.kind !== "verification") {
      warn("step-without-code", `Step ${step.id} (${step.kind}) quotes no code — the reviewer can't tell what it refers to.`, step.id);
    }

    for (const beat of step.beats) {
      for (const block of beat.code ?? []) {
        if (TEST_FILE.test(block.file)) {
          warn("test-file-quoted", `Step ${step.id} quotes a test/snapshot file (${block.file}) — tests should never get their own explanation.`, step.id);
        }
      }
    }
  }

  // --- visual.map should be the exception, not the rule ---
  const totalSteps = walkthrough.steps.length;
  const mapSteps = walkthrough.steps.filter((s) => s.visual?.type === "map").length;
  if (totalSteps > 0 && mapSteps / totalSteps > 0.3) {
    warn("too-many-maps", `${mapSteps} of ${totalSteps} steps use the dependency map — reserve it for structural steps (see docs/output-contract.md).`);
  }

  // --- step count vs. PR size ---
  if (walkthrough.coverage) {
    const explained = walkthrough.coverage.explained;
    const [min, max] = stepBudget(explained);
    const nonMinorSteps = walkthrough.steps.filter((s) => !s.minor).length;
    if (nonMinorSteps < min || nonMinorSteps > max) {
      warn(
        "step-count-out-of-budget",
        `${nonMinorSteps} non-minor step(s) for ${explained} explained hunk(s) — expected ${min}-${max} (see docs/output-contract.md).`
      );
    }
  }

  // --- backend bookkeeping sanity ---
  if (walkthrough.meta.analyzer === "bob-shell" && !walkthrough.meta.run) {
    warn("missing-run-meta", "meta.analyzer is \"bob-shell\" but meta.run is missing — the backend should always attach run stats for a real Bob Shell call.");
  }

  return warnings;
}
