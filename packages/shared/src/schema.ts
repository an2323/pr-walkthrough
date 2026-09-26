/**
 * schema.ts — Zod validators for the Walkthrough contract.
 *
 * Mirrors every type in walkthrough.ts exactly.
 * The backend uses these to validate analyzer output before storing.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive enums
// ---------------------------------------------------------------------------

export const SourceTagSchema = z.enum([
  "fact",
  "commit_history",
  "inferred",
  "unverified",
]);

export const StepKindSchema = z.enum([
  "symptom",
  "cause",
  "constraint",
  "data_origin",
  "decision",
  "change",
  "alternative_rejected",
  "dead_end",
  "open_question",
  "verification",
]);

// ---------------------------------------------------------------------------
// PullRequestMeta
// ---------------------------------------------------------------------------

export const LinkedIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
});

export const PullRequestMetaSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  mergedAt: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  filesChanged: z.number(),
  additions: z.number(),
  deletions: z.number(),
  commitTitles: z.array(z.string()),
  body: z.string().optional(),
  linkedIssues: z.array(LinkedIssueSchema).optional(),
});

// ---------------------------------------------------------------------------
// Hunk
// ---------------------------------------------------------------------------

export const HunkSchema = z.object({
  id: z.string(),
  file: z.string(),
  header: z.string(),
  added: z.number(),
  removed: z.number(),
});

export const SkippedHunkSchema = z.object({
  hunkId: z.string(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Plain-language layer
// ---------------------------------------------------------------------------

export const PlainLayerSchema = z.object({
  title: z.string(),
  problem: z.string(),
  fix: z.string(),
});

// ---------------------------------------------------------------------------
// Visual types (step screen visuals in v2 viewer)
// ---------------------------------------------------------------------------

const FlowRowItemSchema = z.tuple([z.string(), z.string()]);

export const VisualSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("flow"),
    rows: z.array(z.array(FlowRowItemSchema)),
  }),
  z.object({
    type: z.literal("symptoms"),
    items: z.array(z.string()),
  }),
  z.object({
    type: z.literal("map"),
    caption: z.string().optional(),
  }),
  z.object({
    type: z.literal("layers"),
    before: z.array(z.tuple([z.string(), z.number()]).or(z.tuple([z.string(), z.number(), z.string()]))),
    after: z.array(z.tuple([z.string(), z.number()]).or(z.tuple([z.string(), z.number(), z.string()]))),
  }),
  z.object({
    type: z.literal("try"),
  }),
]);

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  sublabel: z.string().optional(),
  file: z.string().optional(),
  kind: z.enum(["file", "module", "runtime", "external"]),
  layout: z.object({ col: z.number(), row: z.number() }).optional(),
  visibleFrom: z.number().optional(),
});

export const GraphEdgeSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  /** Plain-language version of the label for the map; identifier goes to tooltip. */
  plainLabel: z.string().optional(),
  kind: z.enum(["props", "call", "data", "event", "import"]),
  state: z.enum(["before", "after", "unchanged"]),
  problem: z.boolean().optional(),
  visibleFrom: z.number().optional(),
  visibleUntil: z.number().optional(),
});

export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

// ---------------------------------------------------------------------------
// Steps / Beats / Code
// ---------------------------------------------------------------------------

export const TraceStepSchema = z.object({
  label: z.string(),
  status: z.enum(["ok", "bad", "neutral"]).optional(),
});

export const CodeLineSchema = z.object({
  kind: z.enum(["context", "focus", "added", "removed", "elided"]),
  text: z.string(),
  annotation: z.string().optional(),
  annotationTag: SourceTagSchema.optional(),
});

export const CodeBlockSchema = z.object({
  file: z.string(),
  revision: z.enum(["base", "head", "diff"]),
  label: z.string().optional(),
  reconstructed: z.boolean().optional(),
  lines: z.array(CodeLineSchema),
});

export const BeatSchema = z.object({
  kind: z.enum(["current", "problem", "change"]),
  heading: z.string(),
  text: z.string(),
  code: z.array(CodeBlockSchema).optional(),
  traces: z.array(z.array(TraceStepSchema)).optional(),
});

export const SourceRefSchema = z.object({
  type: z.enum([
    "diff",
    "code",
    "code_comment",
    "commit_message",
    "pr_title",
    "pr_description",
    "linked_issue",
    "code_search",
    "test",
    "inference",
  ]),
  ref: z.string(),
});

export const StepSchema = z.object({
  id: z.string(),
  kind: StepKindSchema,
  routeLabel: z.string(),
  title: z.string(),
  /** ≤ 9 words, no identifiers — h1 in v2 viewer. Fallback: routeLabel. */
  headline: z.string().optional(),
  /** One plain sentence, no identifiers. Fallback: first sentence of narration. */
  say: z.string().optional(),
  /** One concrete thing for the reviewer to verify — shown as a checkbox card. */
  check: z.string().optional(),
  /** When true, step is omitted from the main flow; listed in summary only. */
  minor: z.boolean().optional(),
  /** Visual to show on this step screen. */
  visual: VisualSchema.optional(),
  focusNode: z.string(),
  tag: SourceTagSchema,
  isDeadEnd: z.boolean().optional(),
  narration: z.string(),
  beats: z.array(BeatSchema),
  hunkIds: z.array(z.string()),
  skipped: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  sources: z.array(SourceRefSchema),
});

// ---------------------------------------------------------------------------
// Open questions, coverage, verification
// ---------------------------------------------------------------------------

export const OpenQuestionSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  question: z.string(),
  why: z.string(),
  tag: SourceTagSchema,
  /** One-line plain version shown on the step screen. Fallback: question. */
  short: z.string().optional(),
});

export const CoverageSchema = z.object({
  totalHunks: z.number(),
  explained: z.number(),
  skipped: z.number(),
  uncoveredHunkIds: z.array(z.string()),
});

export const VerificationSchema = z.object({
  status: z.enum(["not_run", "passed", "failed"]),
  scenario: z.array(z.string()),
  baseVideoUrl: z.string().optional(),
  headVideoUrl: z.string().optional(),
  testOutput: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Root Walkthrough
// ---------------------------------------------------------------------------

export const WalkthroughSchema = z.object({
  schemaVersion: z.literal(1),
  pr: PullRequestMetaSchema,
  summary: z.object({
    problem: z.string(),
    solution: z.string(),
  }),
  /** Plain-language overlay used by the v2 viewer. */
  plain: PlainLayerSchema.optional(),
  hunks: z.array(HunkSchema),
  graph: GraphSchema,
  steps: z.array(StepSchema),
  skippedHunks: z.array(SkippedHunkSchema),
  openQuestions: z.array(OpenQuestionSchema),
  coverage: CoverageSchema.optional(),
  verification: VerificationSchema.optional(),
  meta: z.object({
    analyzer: z.enum(["bob-shell", "claude", "watsonx", "manual"]),
    model: z.string().optional(),
    generatedAt: z.string(),
    durationMs: z.number().optional(),
    language: z.string(),
  }),
});

export type Walkthrough = z.infer<typeof WalkthroughSchema>;
