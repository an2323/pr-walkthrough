/**
 * Walkthrough schema — the contract between the analyzer (Bob Shell / fallback LLM)
 * and everything else (backend validation, coverage, TTS, React viewer).
 *
 * Design rules encoded here:
 *  - The analyzer decides ORDER and MEANING. The backend decides FACTS it can check
 *    (hunks, coverage, whether quoted code lines really exist).
 *  - Every step and every line annotation carries a SourceTag, so inference is never
 *    presented as fact.
 *  - Two language levels: `narration` (spoken, no identifiers) vs `annotation`
 *    (precise, next to a code line).
 */

/** Where a claim comes from. The UI shows this as a chip on every step. */
export type SourceTag =
  | "fact" // directly visible in the diff, the code, a code comment, or a test
  | "commit_history" // stated in commit messages / squashed commit bullet list
  | "inferred" // the analyzer's own conclusion from reading code; not stated by the author
  | "unverified"; // a claim or scenario nobody has executed yet

/** What role a step plays in the story. Order of steps is by reasoning, not by file. */
export type StepKind =
  | "symptom" // what the user/reviewer sees going wrong
  | "cause" // why it goes wrong
  | "constraint" // what prevents the obvious local fix
  | "data_origin" // where the needed data is born / lives
  | "decision" // the key idea of the solution
  | "change" // a concrete edit that implements the decision
  | "alternative_rejected" // a plausible alternative the PR did not take
  | "dead_end" // an approach the author tried and replaced (from commit history)
  | "open_question" // something the reviewer should ask/check
  | "verification"; // how the fix is (or would be) proven

/** Plain-language layer — analyzer fills these; viewer falls back gracefully when absent. */
export interface PlainLayer {
  title: string;
  problem: string;
  fix: string;
}

/** Highlight box on a before/after screenshot; coordinates are 0..1 of image size. */
export interface ShotHighlight {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  /**
   * Boxes that mark the SAME spot on Before and After share a `pair` id; the
   * backend then gives both the same rectangle (the union of the two), so the
   * eye compares one place. Unpaired boxes keep their own rectangle.
   */
  pair?: string;
}

export interface ShotSide {
  /** Path relative to data/shots/{owner}/{repo}/{number}/; highlights are already drawn into this image. */
  src: string;
  /** The unannotated screenshot `src` was drawn from. */
  raw?: string;
  highlights?: ShotHighlight[];
}

export interface Shots {
  before: ShotSide;
  after: ShotSide;
  caption?: string;
  /** Who produced the screenshots — shown to the reader, so it must be true. */
  by?: "bob-verifier" | "playwright" | "manual";
  /** Bob verifier run stats (backend-filled). */
  run?: { costUsd: number; durationMs: number; toolCalls: number };
}

/** Optional story arcs when a PR has ≥2 independent mechanisms (TopBar shows Part 1 / Part 2). */
export interface WalkthroughPart {
  id: string;
  title: string;
  stepIds: string[];
}

/**
 * One symptom on a symptom step. Plain string is legacy; prefer `{ text, src? }` so each scenario
 * can carry a screenshot (filled in by the backend, never by the analyzer).
 */
export type SymptomItem =
  | string
  | {
      text: string;
      /** Screenshot under data/shots/{owner}/{repo}/{number}/ for this scenario. */
      src?: string;
    };

/** Visual types for step screens. */
export type Visual =
  | {
      type: "flow";
      rows: [string, string][][];
      /** One heading per row ("Before", "After"), so the rows need no "(before)" in their labels. */
      rowTitles?: string[];
    }
  | { type: "symptoms"; items: SymptomItem[] }
  | { type: "map"; caption?: string }
  | { type: "layers"; before: [string, number, string?][]; after: [string, number, string?][] }
  | { type: "try" }
  | { type: "shots"; before: ShotSide; after: ShotSide; caption?: string }
  | { type: "shot"; side: ShotSide; tone?: "bad" | "good"; caption?: string };

export interface Walkthrough {
  schemaVersion: 1;
  pr: PullRequestMeta;
  summary: {
    /** One or two sentences, plain language: what was broken. */
    problem: string;
    /** One or two sentences, plain language: the core idea of the fix. */
    solution: string;
  };
  /** Plain-language overlay. When present, the v2 viewer uses it; otherwise falls back. */
  plain?: PlainLayer;
  /** Before/after screenshots shown on the start screen under Problem / Fix. */
  shots?: Shots;
  /** Independent fix arcs (≥2). Viewer shows Part labels only when this has 2+ entries. */
  parts?: WalkthroughPart[];
  /** Parsed by the BACKEND from the diff, never invented by the analyzer. */
  hunks: Hunk[];
  graph: Graph;
  steps: Step[];
  /** Hunks deliberately not explained in steps (imports, renames, type plumbing...). */
  skippedHunks: SkippedHunk[];
  openQuestions: OpenQuestion[];
  /** Computed by the BACKEND from hunks + steps[].hunkIds + skippedHunks. */
  coverage?: Coverage;
  verification?: Verification;
  meta: {
    analyzer: "bob-shell" | "claude" | "watsonx" | "manual";
    model?: string;
    generatedAt: string; // ISO date
    durationMs?: number;
    /** Output language of narration/text, e.g. "en", "uk". */
    language: string;
    /**
     * Bob Shell run stats, filled by the BACKEND from `bob run`'s stream-json
     * output (never invented by the analyzer). Absent for `meta.analyzer !== "bob-shell"`
     * (e.g. "manual" hand-written examples cost nothing).
     */
    run?: {
      costUsd: number;
      maxCostUsd: number;
      durationMs: number;
      toolCalls: number;
      subagents: number;
      /** How many `--resume` repair attempts were needed (0 = valid on the first pass). */
      repairs: number;
      taskId?: string;
    };
  };
}

export interface PullRequestMeta {
  repo: string; // "outline/outline"
  number: number;
  title: string;
  url: string;
  author: string;
  mergedAt?: string;
  baseSha?: string;
  headSha?: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Commit titles in order. For squash merges: the bullet list from the squash message. */
  commitTitles: string[];
  body?: string;
  linkedIssues?: { number: number; title: string; url: string }[];
}

export interface Hunk {
  /** Stable id: `${file}#${1-based hunk index within file}` */
  id: string;
  file: string;
  header: string; // "@@ -80,22 +80,38 @@ function RevisionViewer(...)"
  added: number;
  removed: number;
}

export interface SkippedHunk {
  hunkId: string;
  /** Short reason shown in the "skipped" list, e.g. "removed unused import". */
  reason: string;
}

// ---------------------------------------------------------------------------
// Graph: files/modules and how data flows between them. Changes across steps.
// ---------------------------------------------------------------------------

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  label: string; // "RevisionViewer"
  sublabel?: string; // "renders the diff editor"
  file?: string; // repo-relative path, if the node is a file
  kind: "file" | "module" | "runtime" | "external";
  /** Optional layout hint. The product may auto-layout (dagre/elk) and ignore this. */
  layout?: { col: number; row: number };
  /** 1-based step number from which the node exists (e.g. a new file). Default: always. */
  visibleFrom?: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Plain-language version of the label, shown on the map; identifier goes to tooltip. */
  plainLabel?: string;
  kind: "props" | "call" | "data" | "event" | "import";
  /** "before" = removed by the PR, "after" = introduced by the PR, "unchanged" = context. */
  state: "before" | "after" | "unchanged";
  /** Draw as the problematic path (e.g. red dashed). */
  problem?: boolean;
  /** 1-based step numbers controlling when the edge is drawn. */
  visibleFrom?: number;
  visibleUntil?: number;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface Step {
  id: string; // "s1"
  kind: StepKind;
  /** Short label for the route rail, ≤ 4 words. */
  routeLabel: string;
  /** Full step title, one line. */
  title: string;
  /** ≤ 9 words, no identifiers — shown as h1 in v2 viewer. Fallback: routeLabel. */
  headline?: string;
  /** One or two short plain sentences shown under the headline — no identifiers. Fallback: first sentence of narration. */
  say?: string;
  /** One concrete thing for the reviewer to verify. When present, shown as a checkbox card. */
  check?: string;
  /** When true, step is omitted from the main flow and listed in the summary only. */
  minor?: boolean;
  /** Visual to show on this step screen. */
  visual?: Visual;
  /** Graph node this step is "standing on". Consecutive steps on different nodes draw a hop. */
  focusNode: string;
  tag: SourceTag;
  /** Rendered struck-through in the route rail (dead ends, rejected alternatives). */
  isDeadEnd?: boolean;
  /**
   * Spoken by TTS. 2–4 sentences. Plain language, NO identifiers, NO file names,
   * explains intent ("we need to keep the count somewhere the header can read it"),
   * never re-reads the code.
   */
  narration: string;
  /** 1–3 beats, in this order when present: current → problem → change. */
  beats: Beat[];
  /** Diff hunks this step explains. Used for coverage. */
  hunkIds: string[];
  /** Minor edits in these hunks that are intentionally not explained. */
  skipped?: string[];
  /** Extra remarks shown in muted text (e.g. why something is inferred). */
  notes?: string[];
  sources: SourceRef[];
  /** Backend-computed (ST12), never set by the analyzer — see `StepEvidence`. */
  evidence?: StepEvidence;
}

export interface Beat {
  kind: "current" | "problem" | "change";
  heading: string; // "How it works now" / "What breaks" / "What we change"
  text: string; // 1–3 sentences, may mention identifiers in `backticks`
  code?: CodeBlock[];
  /** Concrete value traces, e.g. [?changes] → [get() → ""] → [return null]. */
  traces?: TraceStep[][];
}

export interface CodeBlock {
  file: string;
  /** Which version the lines are quoted from. The backend verifies quoted lines exist there. */
  revision: "base" | "head" | "diff";
  label?: string; // "before the change", "unchanged code", "test"
  /**
   * true = lines are NOT in any revision (e.g. an intermediate version reconstructed
   * from a commit title). Must also set tag "inferred" on the step or annotation.
   */
  reconstructed?: boolean;
  lines: CodeLine[];
}

export interface CodeLine {
  kind: "context" | "focus" | "added" | "removed" | "elided";
  /** Verbatim source text (except kind "elided", which is a short placeholder like "…"). */
  text: string;
  /** Only on load-bearing lines. One sentence. Shown under the line as "↳ ...". */
  annotation?: string;
  annotationTag?: SourceTag;
  /**
   * 1-based line number in the revision this line is quoted from. Backend-computed
   * (validation/line-numbers.ts) from the analyzer's verbatim text — never set by
   * the analyzer itself. Absent on "elided" lines and on a "reconstructed" block.
   */
  n?: number;
  /**
   * Whether the PR actually added or removed this exact line, computed by the
   * backend from the diff — independent of `kind`, which is the analyzer's own
   * "look here" judgement and can disagree (e.g. a genuinely-changed line the
   * analyzer only marked "focus"). Absent means the PR left this line alone.
   */
  change?: "added" | "removed";
}

export interface TraceStep {
  label: string;
  status?: "ok" | "bad" | "neutral";
}

export interface SourceRef {
  type:
    | "diff"
    | "code"
    | "code_comment"
    | "commit_message"
    | "pr_title"
    | "pr_description"
    | "linked_issue"
    | "code_search"
    | "test"
    | "inference";
  /** Human-readable pointer: file:line, commit title, issue number, search query... */
  ref: string;
}

export interface OpenQuestion {
  id: string;
  stepId: string;
  question: string; // phrased as a reviewer would ask the author
  /** Short one-line plain version of the question for the step screen. Fallback: question. */
  short?: string;
  why: string; // what in the code made the analyzer ask
  tag: SourceTag; // usually "inferred"
}

export interface Coverage {
  totalHunks: number;
  explained: number;
  skipped: number;
  /** Hunks referenced by neither a step nor skippedHunks — shown as a warning. */
  uncoveredHunkIds: string[];
}

export interface Verification {
  /**
   * "skipped" = pipeline decided screenshots/repro aren't meaningful for this
   * PR (e.g. pure perf) — not a failure, just no visual evidence path.
   */
  status: "not_run" | "passed" | "failed" | "skipped";
  /** Human-readable scenario, one action → expectation per line. */
  scenario: string[];
  /** Why verification was skipped (when status === "skipped"). Plain words — shown to the reader. */
  skipReason?: string;
  /**
   * Why there are no before/after pictures although the bug was reproduced
   * (e.g. the two frames look the same in a still). Plain words — shown to the reader.
   */
  shotsNote?: string;
  baseVideoUrl?: string;
  headVideoUrl?: string;
  testOutput?: string;
  /**
   * ST12 evidence loop: which of the PR's hunks the fix actually needs,
   * measured by re-running the verifier's own repro script against BASE
   * with different subsets of the diff applied — not inferred from reading
   * the code. Absent when the PR has no working repro script (no app
   * recipe, or the script didn't reproduce true-on-BASE/false-on-HEAD).
   */
  ablation?: Ablation;
}

/** One hunk-level unit tested by the ablation runner (verify/ablation.ts). */
export interface AblationRun {
  /** Hunk ids applied to a fresh BASE checkout for this run. */
  unitIds: string[];
  mode: "alone" | "all-but-one";
  /** "broken" = the app didn't build/start/respond with this subset applied — itself a finding. */
  verdict: "fixed" | "bug" | "broken";
  detail?: string;
  /**
   * One verdict per measured scenario (same build, each scenario's own repro script). `verdict`
   * above is then a summary for old readers: "bug" if any scenario still shows its bug, "fixed" if
   * all that ran are fixed, "broken" if none gave an answer. Absent for single-scenario ablations.
   */
  results?: { scenarioId: string; verdict: "fixed" | "bug" | "broken"; detail?: string }[];
}

export interface AblationScenario {
  id: string;
  /** Plain words: the user-visible behaviour this scenario checks ("menu opens with the sidebar still open"). */
  title: string;
}

export interface Ablation {
  /** The logic hunks considered (excludes mechanical/skippedHunks); capped, see verify/ablation.ts. */
  units: string[];
  runs: AblationRun[];
  /** The scenarios measured. Absent = one unnamed scenario (older walkthroughs). */
  scenarios?: AblationScenario[];
}

/**
 * Evidence-based check of a step's own claim (ST12), attached by the backend
 * after the analyzer runs — never set by the analyzer itself:
 *  - "ablation": this step's hunk(s) were re-run against the repro script in
 *    isolation and in "all but this one" (see `Ablation` above).
 *  - "critic": a separate read-only Bob pass reviewed the step's claims
 *    against the code (mechanism / counterfactual / importance), for PRs or
 *    steps ablation can't reach (no app recipe, non-visual change).
 */
export type StepEvidence =
  | { source: "ablation"; verdict: "needed" | "fixes-alone" | "no-effect" | "not-separable" }
  | { source: "critic"; verdict: "supported" | "unsupported" | "contradicted"; note?: string };
