/**
 * Builds a PlainData object from a Walkthrough.
 * Uses step.headline, step.say, step.check, step.minor, step.visual when present.
 * Falls back to step.routeLabel and first sentence of step.narration.
 * Chapter is derived from the step index — first half = "problem", rest = "fix",
 * last step with kind="verification" or "open_question" = "check".
 */

import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData, PlainStep, PlainVisual } from './v2types';

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?]+[.!?]/);
  return m ? m[0].trim() : text.split('\n')[0].trim();
}

function stepChapter(step: Step, allSteps: Step[]): string {
  // last step is verification → "check"
  const idx = allSteps.indexOf(step);
  if (step.kind === 'verification' || step.kind === 'open_question') return 'check';
  // Steps before the first "change" or "decision" kind are problem steps
  const firstFix = allSteps.findIndex(
    (s) => s.kind === 'decision' || s.kind === 'change' || s.kind === 'alternative_rejected'
  );
  if (firstFix < 0 || idx < firstFix) return 'problem';
  return 'fix';
}

/** The analyzer's event traces (e.g. "tap → handler → result"), drawn as a flow when a step has no visual. */
function tracesVisual(step: Step): PlainVisual | undefined {
  const traces = step.beats.flatMap((b) => b.traces ?? []);
  if (traces.length === 0) return undefined;
  return {
    type: 'flow',
    rows: traces.map((t) =>
      t.map((x): [string, string] => [x.label, x.status === 'bad' ? 'bad' : x.status === 'ok' ? 'good' : ''])
    ),
  };
}

function stepVisual(step: Step): PlainVisual | undefined {
  if (!step.visual) return tracesVisual(step);
  const v = step.visual;
  if (v.type === 'flow') {
    return { type: 'flow', rows: v.rows as [string, string][][] };
  }
  if (v.type === 'symptoms') return { type: 'symptoms', items: v.items };
  if (v.type === 'map') return { type: 'map', caption: v.caption };
  if (v.type === 'layers') {
    return {
      type: 'layers',
      before: v.before as [string, number, string?][],
      after: v.after as [string, number, string?][],
    };
  }
  if (v.type === 'shots') {
    return { type: 'shots', before: v.before, after: v.after, caption: v.caption };
  }
  return undefined;
}

/** A symptom that only restates the start-screen problem (no picture, no code) is not its own screen. */
function isEmptySymptom(step: Step, visual: PlainVisual | undefined): boolean {
  if (step.kind !== 'symptom') return false;
  if (visual) return false;
  return !step.beats.some((b) => (b.code ?? []).length > 0);
}

export function buildPlainData(w: Walkthrough): PlainData {
  // If the walkthrough has a plain overlay already, use it
  const plain = w.plain;
  const title = plain?.title ?? w.pr.title;
  const problem = plain?.problem ?? w.summary.problem;
  const fix = plain?.fix ?? w.summary.solution;

  const steps: Record<string, PlainStep> = {};

  for (const step of w.steps) {
    const ch = stepChapter(step, w.steps);
    const head = step.headline ?? step.routeLabel;
    const say = step.say ?? firstSentence(step.narration);
    const detour = step.isDeadEnd ?? step.kind === 'dead_end';
    const visual = stepVisual(step);
    const check = step.check;
    // Covered by start screen (problem text ± shots) — list nowhere, not even as a minor.
    const skip = isEmptySymptom(step, visual);
    const minor = skip ? true : (step.minor ?? false);

    steps[step.id] = {
      ch,
      head,
      say,
      check,
      minor,
      skip: skip || undefined,
      detour: detour || undefined,
      visual,
    };
  }

  return { title, problem, fix, steps };
}
