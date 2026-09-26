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
  /**
   * Optional progress hook (ST6c): fired with each raw `bob run
   * --format stream-json` event as it arrives, in real time.
   * `BobShellAnalyzer` only — `CachedAnalyzer` never calls Bob, so it's
   * simply unused there. The caller is expected to normalize these into
   * `ProgressEvent`s (see analyzer/progress-normalizer.ts) rather than
   * forward them as-is: raw events include the full prompt echo.
   */
  onEvent?: (e: unknown) => void;
}

export interface Analyzer {
  analyze(input: AnalyzerInput): Promise<WalkthroughDraft>;
}
