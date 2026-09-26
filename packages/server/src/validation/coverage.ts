/**
 * coverage.ts — compute the Coverage object from the analyzer's draft and
 * the full list of hunks parsed from the diff.
 */

import type { Hunk, Coverage } from "@pr-walkthrough/shared";
import type { WalkthroughDraft } from "../analyzer/interface.js";

/**
 * Compute coverage statistics.
 *
 * - `explained`       = count of allHunks whose id appears in any step's hunkIds
 * - `skipped`         = count of allHunks whose id appears in skippedHunks
 * - `uncoveredHunkIds` = ids of allHunks appearing in neither
 *
 * A hunk can only be counted in one category. If the same id appears in both
 * a step and skippedHunks it is counted as explained (steps take precedence).
 */
export function computeCoverage(
  draft: WalkthroughDraft,
  allHunks: Hunk[]
): Coverage {
  const stepHunkIds = new Set<string>(
    draft.steps.flatMap((s) => s.hunkIds)
  );
  const skippedHunkIds = new Set<string>(
    draft.skippedHunks.map((s) => s.hunkId)
  );

  let explained = 0;
  let skipped = 0;
  const uncoveredHunkIds: string[] = [];

  for (const hunk of allHunks) {
    if (stepHunkIds.has(hunk.id)) {
      explained++;
    } else if (skippedHunkIds.has(hunk.id)) {
      skipped++;
    } else {
      uncoveredHunkIds.push(hunk.id);
    }
  }

  return {
    totalHunks: allHunks.length,
    explained,
    skipped,
    uncoveredHunkIds,
  };
}
