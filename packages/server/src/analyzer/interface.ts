/**
 * interface.ts — shared types used across the analyzer and validation pipeline.
 */

import type {
  Walkthrough,
  Hunk,
  PullRequestMeta,
} from "@pr-walkthrough/shared";

/**
 * What the analyzer returns.
 * The backend fills `hunks` and `coverage` after validation.
 */
export type WalkthroughDraft = Omit<Walkthrough, "hunks" | "coverage">;

export interface AnalyzerInput {
  repoPath: string;
  baseSha: string;
  headSha: string;
  pr: PullRequestMeta;
  hunks: Hunk[];
  diff: string;
}

export interface Analyzer {
  analyze(input: AnalyzerInput): Promise<WalkthroughDraft>;
}
