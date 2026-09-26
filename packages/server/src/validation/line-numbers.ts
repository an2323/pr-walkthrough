/**
 * validation/line-numbers.ts — attach a real line number and a diff-derived
 * change marker to every quoted CodeLine (ST12/redesign step 1), and flag
 * quoted lines that are secretly non-contiguous (missing an `elided` marker).
 *
 * Two things the analyzer must NOT be trusted to get right, computed here
 * instead, from facts the backend already has:
 *  - `n`: the line's 1-based position in the file at the quoted revision,
 *    found the same way a GitHub review comment is anchored (text + same-side
 *    neighbours — see util/code-lines.ts). This is what lets the viewer show
 *    real line numbers and an "open file ↗#L{n}" link.
 *  - `change`: whether the PR actually added/removed this exact line, from
 *    the diff — independent of the analyzer's own `kind` ("focus" vs
 *    "added"/"removed" is the analyzer's "look here" judgement, not a
 *    reliable record of what changed; a #10943 run marked genuinely-changed
 *    lines "focus" and a genuinely-unchanged one "removed" nowhere, so the
 *    viewer's +/- gutter must not depend on `kind` alone).
 *
 * Contiguity: consecutive non-elided lines quoted from the SAME side (base or
 * head) of a block must be adjacent in the real file — `n[i+1] === n[i] + 1`.
 * A gap without an `elided` line between them means the reader is shown
 * stitched-together code as if it were one continuous piece (seen in a real
 * #10943 step, which silently skipped a line of a base SCSS block, and in the
 * outline golden example, which silently skipped a real statement). This is
 * a validation ERROR, not a warning: it's a correctness bug in the quote.
 * Two exceptions, or every real-world quote with a blank spacer line would
 * fail: a gap is allowed when the skipped file lines are themselves all
 * blank (a cosmetic spacer, not content), and a comparison is skipped
 * entirely when either endpoint's own quoted text is blank (an empty line's
 * position is ambiguous — many identical blank lines in a file — so its `n`
 * is a best guess, not a reliable anchor for this check either way).
 */

import type { WalkthroughDraft } from "../analyzer/interface.js";
import type { RepoWorkspace } from "../git/workspace.js";
import { sideOf, locateLine, type Side } from "../util/code-lines.js";
import { parseDiffChangedLines, type FileChangedLines } from "../diff/changed-lines.js";

/**
 * Mutates `draft` in place, setting `n`/`change` on every non-elided,
 * non-reconstructed CodeLine. Returns contiguity errors (empty = none).
 */
export async function annotateLines(
  draft: WalkthroughDraft,
  workspace: RepoWorkspace,
  diff: string
): Promise<string[]> {
  const errors: string[] = [];
  const changedByFile = parseDiffChangedLines(diff);

  // Same revision-file cache pattern as checkVerbatim — avoid redundant git reads.
  const fileCache = new Map<string, string[]>();
  async function linesOf(file: string, revision: "base" | "head"): Promise<string[]> {
    const key = `${revision}:${file}`;
    const cached = fileCache.get(key);
    if (cached) return cached;
    let lines: string[];
    try {
      lines = (await workspace.readFile(file, revision)).replace(/\r\n/g, "\n").split("\n");
    } catch {
      lines = []; // file doesn't exist at this revision (e.g. added by the PR) — n stays unset
    }
    fileCache.set(key, lines);
    return lines;
  }

  const isChanged = (changes: FileChangedLines | undefined, side: Side, n: number): boolean => {
    if (!changes) return false;
    return side === "LEFT" ? changes.removed.has(n) : changes.added.has(n);
  };

  for (const step of draft.steps) {
    for (let bi = 0; bi < step.beats.length; bi++) {
      const beat = step.beats[bi];
      if (!beat.code) continue;

      for (let ci = 0; ci < beat.code.length; ci++) {
        const block = beat.code[ci];
        if (block.reconstructed === true) continue; // not in any revision — nothing to locate

        const changes = changedByFile.get(block.file);
        let prev: { side: Side; n: number; blank: boolean } | undefined;

        for (let li = 0; li < block.lines.length; li++) {
          const line = block.lines[li];
          if (line.kind === "elided") {
            prev = undefined; // an explicit gap — contiguity resumes after it
            continue;
          }

          const side = sideOf(block.revision, line.kind);
          const revision = block.revision === "diff" ? (line.kind === "removed" ? "base" : "head") : block.revision;
          const fileLines = await linesOf(block.file, revision);
          const n = locateLine(fileLines, { revision: block.revision, lines: block.lines, index: li });

          if (n === null) {
            // checkVerbatim (run just before this) already guarantees the text exists
            // somewhere in the file, so this should not happen — but never throw over it.
            prev = undefined;
            continue;
          }

          line.n = n;
          if (isChanged(changes, side, n)) line.change = side === "LEFT" ? "removed" : "added";

          const isBlank = line.text.trim() === "";
          if (prev && prev.side === side && n !== prev.n + 1 && !prev.blank && !isBlank) {
            // Forward gap where every file line strictly between them is itself blank
            // (0-based slice: file lines prev.n+1 .. n-1) is a cosmetic spacer, not a
            // stitching bug — n <= prev.n (out of order) is never exempted this way.
            const spacerOnly = n > prev.n && fileLines.slice(prev.n, n - 1).every((l) => l.trim() === "");
            if (!spacerOnly) {
              errors.push(
                `step ${step.id} beat ${bi} block ${ci} line ${li}: quoted lines ${li - 1} and ${li} of ` +
                  `${block.file} are not adjacent in the file (line ${prev.n} then ${n}) with no "elided" ` +
                  `line between them — the reader is shown stitched-together code as one continuous piece`
              );
            }
          }
          prev = { side, n, blank: isBlank };
        }
      }
    }
  }

  return errors;
}
