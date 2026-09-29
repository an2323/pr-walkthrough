/**
 * v2 types — plain-language overlay data used by the v2 viewer.
 * Merges data from the Walkthrough JSON (step.headline, step.say, etc.)
 * with the PLAINS fallback values embedded in the walkthrough or hard-coded.
 */

import type { Shots, ShotSide } from '@pr-walkthrough/shared';

export interface PlainStep {
  /** Chapter this step belongs to ("problem" | "fix" | "check") */
  ch: string;
  /** Plain-language headline (≤9 words). Falls back to step.routeLabel. */
  head: string;
  /** One plain sentence. Falls back to first sentence of step.narration. */
  say: string;
  /** Checkbox card text, if any. */
  check?: string;
  /** Minor step — listed in summary only. */
  minor?: boolean;
  /** Dropped from the flow and from the summary (e.g. empty symptom already covered on the start screen). */
  skip?: boolean;
  /** Detour (dead-end). */
  detour?: boolean;
  /** Visual spec. */
  visual?: PlainVisual;
  /** Code reference: [stepId, beatIndex, codeIndex]. */
  code?: [string, number, number];
}

export type PlainVisual =
  | { type: 'flow'; rows: [string, string][][]; rowTitles?: string[] }
  | { type: 'symptoms'; items: Array<string | { text: string; src?: string }> }
  | { type: 'map'; caption?: string }
  | { type: 'layers'; before: [string, number, string?][]; after: [string, number, string?][] }
  | { type: 'try' }
  | ({ type: 'shots' } & Shots)
  | { type: 'shot'; side: ShotSide; tone?: 'bad' | 'good'; caption?: string };

export interface PlainData {
  title: string;
  problem: string;
  fix: string;
  steps: Record<string, PlainStep>;
  edges?: Record<string, string>;
  questions?: Record<string, string>;
}
