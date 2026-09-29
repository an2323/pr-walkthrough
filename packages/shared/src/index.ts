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
  Visual,
  ShotHighlight,
  ShotSide,
  Shots,
  WalkthroughPart,
  Ablation,
  AblationRun,
  AblationScenario,
  StepEvidence,
  SymptomItem,
} from "./walkthrough.js";

// Zod schemas (for runtime validation)
export {
  SourceTagSchema,
  StepKindSchema,
  PlainLayerSchema,
  VisualSchema,
  ShotsSchema,
  WalkthroughPartSchema,
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
  AblationSchema,
  AblationRunSchema,
  WalkthroughSchema,
} from "./schema.js";

// Hunk parsing utilities
export { parseHunks, hunkId } from "./hunk-ids.js";

// Live-analysis progress events (ST6c)
export type { ProgressStage, ProgressEvent, ProgressEventOf } from "./progress.js";
