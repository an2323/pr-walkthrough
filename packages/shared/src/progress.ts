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
  | "shots" // Bob reproduces the scenario and takes before/after screenshots
  | "ablation" // which of the PR's changes the fix needs: each change tried alone / left out in the running app
  | "voicing"; // narration audio generated (ElevenLabs) so the walkthrough plays at once

/**
 * How the screenshot stage ended (or why it will not run). Plain-language reasons travel with the code,
 * so the screen never has to parse free text or show a raw error.
 */
export type ShotsOutcomeCode =
  | "ok" // bug reproduced, before/after frames exist
  | "identical" // reproduced and verified, but a still image shows no difference
  | "no-recipe" // this repository is not one whose app we can start
  | "non-visual" // nothing to see in the running app
  | "app-failed" // the app could not be installed or started
  | "not-reproduced" // the app ran, but the bug could not be reproduced reliably
  | "unavailable"; // the screenshot tool is off, out of credits, or crashed

export type ProgressEvent =
  /** Sent once the PR is known: its size and whether screenshots are planned for this repository. */
  | {
      kind: "plan";
      t: number;
      pr: { title: string; additions: number; deletions: number; files: number };
      shots: { planned: boolean; reason?: string };
      /** Narration will be recorded at the end (a voice is configured on this server). */
      voice?: { planned: boolean };
      /**
       * How long this run will take, from what is known at the start: screenshots or not, how many
       * ablation builds, whether the app still has to be installed. Minutes, a range.
       */
      estimate?: { minMinutes: number; maxMinutes: number; ablationBuilds: number; coldInstall: boolean };
    }
  /** The changed files (after the diff is parsed); `skipped` = only mechanical hunks, hidden from Bob. */
  | { kind: "files"; t: number; files: { path: string; additions: number; deletions: number; skipped: boolean }[] }
  /** What the verifier will try in the running app (the scenario lines from the analysis). */
  | { kind: "scenario"; t: number; lines: string[] }
  /** The screenshot stage ended. `message` is a plain sentence for the reader. */
  | { kind: "outcome"; t: number; what: "shots"; code: ShotsOutcomeCode; message: string }
  /** Before/after frames are ready (paths relative to /data/shots/{owner}/{repo}/{number}/). */
  | { kind: "frames"; t: number; before: string; after: string; caption?: string }
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
