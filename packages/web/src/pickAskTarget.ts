/**
 * Pick the code line an open question should attach to — prefer lines whose
 * text/annotation overlap the question, then annotated / focus / changed lines.
 */

import type { CodeBlock, CodeLine, OpenQuestion, Step } from '@pr-walkthrough/shared';

export interface AskTarget {
  blockIndex: number;
  block: CodeBlock;
  lineIndex: number;
}

function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [];
}

function scoreLine(line: CodeLine, qTokens: string[]): number {
  if (line.kind === 'elided') return -Infinity;
  const hay = `${line.text} ${line.annotation ?? ''}`.toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    if (hay.includes(t)) score += t.length >= 10 ? 4 : 2;
  }
  if (line.annotation) score += 2;
  if (line.kind === 'focus') score += 2;
  if (line.kind === 'added' || line.change === 'added') score += 1;
  if (line.kind === 'removed' || line.change === 'removed') score += 1;
  return score;
}

function fallbackLine(block: CodeBlock): number | null {
  const lines = block.lines;
  const ranked = [
    (l: CodeLine) => l.kind === 'focus' && !!l.annotation,
    (l: CodeLine) => !!l.annotation,
    (l: CodeLine) => l.kind === 'focus',
    (l: CodeLine) => l.kind === 'added' || l.change === 'added',
    (l: CodeLine) => l.kind === 'removed' || l.change === 'removed',
    (l: CodeLine) => l.kind !== 'elided',
  ];
  for (const pred of ranked) {
    const i = lines.findIndex(pred);
    if (i >= 0) return i;
  }
  return null;
}

/** Best commentable line in the step's code for this question, or null. */
export function pickAskTarget(step: Step, question: OpenQuestion): AskTarget | null {
  if (step.kind === 'symptom') return null;

  const qTokens = tokens(
    `${question.question} ${question.short ?? ''} ${question.why}`
  );

  let best: AskTarget | null = null;
  let bestScore = -1;
  let blockIndex = 0;

  for (const beat of step.beats) {
    for (const block of beat.code ?? []) {
      if (!block.reconstructed) {
        for (let lineIndex = 0; lineIndex < block.lines.length; lineIndex++) {
          const score = scoreLine(block.lines[lineIndex], qTokens);
          if (score > bestScore) {
            bestScore = score;
            best = { blockIndex, block, lineIndex };
          }
        }
      }
      blockIndex++;
    }
  }

  if (best && bestScore >= 2) return best;

  // No token overlap — still attach to a load-bearing line in the first real block.
  blockIndex = 0;
  for (const beat of step.beats) {
    for (const block of beat.code ?? []) {
      if (!block.reconstructed) {
        const lineIndex = fallbackLine(block);
        if (lineIndex != null) return { blockIndex, block, lineIndex };
      }
      blockIndex++;
    }
  }

  return null;
}

/** Flat list of code blocks as StepScreen / CodeFold render them. */
export function stepCodeBlocks(step: Step): CodeBlock[] {
  if (step.kind === 'symptom') return [];
  return step.beats.flatMap((b) => b.code ?? []);
}
