/**
 * progress.ts — the small, UI-facing event stream for a live (or replayed)
 * analysis run (ST6c). This is deliberately NOT the raw `bob run
 * --format stream-json` event shape (see packages/server/src/analyzer/
 * progress-normalizer.ts) — it's what's left after dropping the prompt
 * echo, collapsing thousands of assistant text deltas, and picking a
 * human-readable target out of a tool call's raw parameters. Shared between
 * the server (which emits it, live or replayed from a recorded file) and
 * the web viewer (which renders it in ProgressScreen), so both sides agree
 * on the shape without duplicating it.
 */

/** Stages the backend itself adds around the analyzer call. */
export type ProgressStage =
  | "clone" // git workspace / worktree prep
  | "hunks" // diff parsed, mechanical hunks pre-skipped
  | "analyzing" // the analyzer (Bob Shell or cached lookup) is running
  | "validating" // schema + verbatim + coverage checks
  | "repairing" // one repair attempt via --resume after a failed validation
  | "saving" // writing the walkthrough JSON to disk
  | "app" // installing and starting the app at BASE and HEAD (screenshot verifier)
  | "shots"; // Bob reproduces the scenario and takes before/after screenshots

export type ProgressEvent =
  /** A pipeline stage started. */
  | { kind: "stage"; t: number; stage: ProgressStage; label: string }
  /** Bob read/searched something, or spawned a sub-agent. */
  | { kind: "tool"; t: number; tool: string; target: string }
  /** Assistant text deltas collapsed into one throttled "writing" signal (~1/sec). */
  | { kind: "writing"; t: number; chars: number }
  /** Running spend, from a bob `result` event. */
  | { kind: "cost"; t: number; costUsd: number; maxCostUsd?: number }
  /** The pipeline finished and the walkthrough is ready to view. */
  | {
      kind: "done";
      t: number;
      walkthroughUrl: string;
      durationMs: number;
      costUsd?: number;
      toolCalls?: number;
      subagents?: number;
    }
  /** The pipeline failed. */
  | { kind: "error"; t: number; message: string };

/** Discriminant helper — narrows a `ProgressEvent` by its `kind`. */
export type ProgressEventOf<K extends ProgressEvent["kind"]> = Extract<ProgressEvent, { kind: K }>;
