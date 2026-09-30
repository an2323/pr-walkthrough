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
import { anchorQuotes } from "./anchor.js";

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
/** "…line 7: quoted lines 6 and 7 of X are not adjacent in the file…" (line-numbers.ts). */
const GAP = /^step (\S+) beat (\d+) block (\d+) line (\d+): quoted lines.*not adjacent/;
const UNCOVERED = /^uncovered hunks: (.+)$/;

/**
 * Two failures have one correct mechanical fix, so they never cost a paid repair or a failed run:
 *  - stitched code (two quoted lines not adjacent in the file) → an "elided" line between them;
 *  - a hunk the walkthrough left out → listed in skippedHunks, saying so plainly.
 * Applied only when EVERY remaining error is one of these. Returns what was fixed, or undefined.
 */
function mechanicalFixes(draft: WalkthroughDraft, errors: string[]): string[] | undefined {
  if (errors.length === 0 || !errors.every((e) => GAP.test(e) || UNCOVERED.test(e))) return undefined;
  const fixed: string[] = [];
  const gaps = errors
    .map((e) => GAP.exec(e))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[4]) - Number(a[4])); // later lines first, so earlier indices stay valid
  for (const [, stepId, bi, ci, li] of gaps) {
    const lines = draft.steps.find((s) => s.id === stepId)?.beats?.[Number(bi)]?.code?.[Number(ci)]?.lines;
    if (!lines) return undefined;
    lines.splice(Number(li), 0, { kind: "elided", text: "…" } as (typeof lines)[number]);
    fixed.push(`elided line in ${stepId} beat ${bi} block ${ci} before line ${li}`);
  }
  for (const e of errors) {
    const m = UNCOVERED.exec(e);
    if (!m) continue;
    // A new array: the draft may share its skippedHunks with a caller's object.
    const skipped = [...(draft.skippedHunks ?? [])];
    for (const hunkId of m[1].split(", ").map((x) => x.trim()).filter(Boolean)) {
      if (skipped.some((s) => s.hunkId === hunkId)) continue;
      skipped.push({ hunkId, reason: "Not explained in this walkthrough — the analysis left this change out." });
      fixed.push(`${hunkId} listed as not explained`);
    }
    draft.skippedHunks = skipped;
  }
  return fixed;
}

export async function validate(
  draft: WalkthroughDraft,
  input: AnalyzerInput,
  workspace: RepoWorkspace,
  opts: { mechanicalFix?: boolean } = {}
): Promise<ValidationResult> {
  const result = await validateOnce(draft, input, workspace);
  if (result.valid || opts.mechanicalFix === false) return result;
  const fixed = mechanicalFixes(draft, result.errors);
  if (!fixed) return result;
  console.log(`[validate] fixed mechanically:\n  ${fixed.join("\n  ")}`);
  return validateOnce(draft, input, workspace);
}

async function validateOnce(
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

  // --- 1b. Tie every quote to the real file (anchor.ts): the shown code is the PR's own ---
  await anchorQuotes(draft, workspace);

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
export { checkQuality, criticalQualityWarnings, CRITICAL_QUALITY_CODES } from "./quality.js";
export type { QualityWarning } from "./quality.js";
