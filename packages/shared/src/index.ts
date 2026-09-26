// packages/shared/src/index.ts
// Public API of @pr-walkthrough/shared

// TypeScript types (source-of-truth definitions)
export type {
  SourceTag,
  StepKind,
  Walkthrough,
  PullRequestMeta,
  Hunk,
  SkippedHunk,
  Graph,
  GraphNode,
  GraphEdge,
  Step,
  Beat,
  CodeBlock,
  CodeLine,
  TraceStep,
  SourceRef,
  OpenQuestion,
  Coverage,
  Verification,
} from "./walkthrough.js";

// Zod schemas (for runtime validation)
export {
  SourceTagSchema,
  StepKindSchema,
  PlainLayerSchema,
  VisualSchema,
  PullRequestMetaSchema,
  HunkSchema,
  SkippedHunkSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  GraphSchema,
  TraceStepSchema,
  CodeLineSchema,
  CodeBlockSchema,
  BeatSchema,
  SourceRefSchema,
  StepSchema,
  OpenQuestionSchema,
  CoverageSchema,
  VerificationSchema,
  WalkthroughSchema,
} from "./schema.js";

// Hunk parsing utilities
export { parseHunks, hunkId } from "./hunk-ids.js";
