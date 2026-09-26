/**
 * validation/index.ts — orchestrates schema, verbatim, and coverage checks.
 */

import type { Walkthrough } from "@pr-walkthrough/shared";
import type { WalkthroughDraft, AnalyzerInput } from "../analyzer/interface.js";
import type { RepoWorkspace } from "../git/workspace.js";
import { validateSchema } from "./schema.js";
import { checkVerbatim } from "./verbatim.js";
import { computeCoverage } from "./coverage.js";
import { annotateLines } from "./line-numbers.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Only set when valid === true. */
  walkthrough?: Walkthrough;
}

/**
 * Run the full validation pipeline in order:
 *   1. Schema check  — abort early on failure (verbatim needs a well-formed struct)
 *   2. Verbatim check — every non-elided code line must exist in the repo
 *   3. Coverage — compute and attach; treat uncovered hunks as a soft warning
 *      (included in errors but does not invalidate an otherwise clean result)
 *
 * On success, attaches `hunks` and `coverage` to produce the full `Walkthrough`.
 */
export async function validate(
  draft: WalkthroughDraft,
  input: AnalyzerInput,
  workspace: RepoWorkspace
): Promise<ValidationResult> {
  // --- 1. Schema ---
  const schemaResult = validateSchema(draft);
  if (!schemaResult.valid) {
    return { valid: false, errors: schemaResult.errors };
  }

  const allErrors: string[] = [];

  // --- 2. Verbatim ---
  const verbatimResult = await checkVerbatim(draft, workspace);
  if (!verbatimResult.valid) {
    allErrors.push(...verbatimResult.errors);
  }

  // --- 2b. Line numbers, change markers, contiguity (only meaningful once verbatim
  // passed — a line the verbatim check couldn't find can't be reliably located either,
  // so its `n`/`change` would be noise on top of an already-failing draft). Mutates
  // `draft`'s code blocks in place; the mutation is still visible in `walkthrough`
  // below since the spread there is shallow.
  if (verbatimResult.valid) {
    const lineErrors = await annotateLines(draft, workspace, input.diff);
    allErrors.push(...lineErrors);
  }

  // --- 3. Coverage ---
  const coverage = computeCoverage(draft, input.hunks);
  if (coverage.uncoveredHunkIds.length > 0) {
    allErrors.push(
      `uncovered hunks: ${coverage.uncoveredHunkIds.join(", ")}`
    );
  }

  if (allErrors.length > 0) {
    return { valid: false, errors: allErrors };
  }

  // All checks passed — assemble the full Walkthrough.
  const walkthrough: Walkthrough = {
    ...draft,
    hunks: input.hunks,
    coverage,
  };

  return { valid: true, errors: [], walkthrough };
}

export { validateSchema } from "./schema.js";
export { checkVerbatim } from "./verbatim.js";
export { computeCoverage } from "./coverage.js";
export { checkQuality } from "./quality.js";
export type { QualityWarning } from "./quality.js";
