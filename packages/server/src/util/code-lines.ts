/**
 * util/code-lines.ts — locate a quoted CodeLine's position in a file.
 *
 * CodeLines carry no line numbers from the analyzer, so a line is found in the
 * file at the right revision by its text, disambiguated by the neighbouring
 * lines of the same block (same technique GitHub review comments need to
 * anchor a quote to a real line — see github/review.ts — and what
 * validation/line-numbers.ts uses to number every quoted line and mark which
 * ones the PR changed).
 */

import type { CodeLine } from "@pr-walkthrough/shared";

const NEIGHBOURS = 5;

export type Side = "LEFT" | "RIGHT";

/** The minimum a caller needs to locate one line of a quoted CodeBlock. */
export interface LineAnchor {
  revision: "base" | "head" | "diff";
  lines: Pick<CodeLine, "kind" | "text">[];
  index: number;
}

/** Which file revision a block line lives in: base ("LEFT" of a diff) or head ("RIGHT"). */
export function sideOf(revision: LineAnchor["revision"], kind: CodeLine["kind"]): Side {
  if (revision === "base") return "LEFT";
  if (revision === "head") return "RIGHT";
  return kind === "removed" ? "LEFT" : "RIGHT";
}

/**
 * 1-based line number of `anchor.lines[anchor.index]` in `fileLines`, or null if
 * the text isn't there at all. Candidates are scored by how many same-side
 * neighbours (up to NEIGHBOURS each way, stopping at an elided line) also
 * match; ties go to the first candidate. `fileLines` must already be the
 * correct revision's content — the caller decides that from `sideOf`.
 */
export function locateLine(fileLines: string[], anchor: LineAnchor): number | null {
  const target = anchor.lines[anchor.index];
  if (!target || target.kind === "elided") return null;
  const side = sideOf(anchor.revision, target.kind);
  const norm = (s: string) => s.trimEnd();
  const file = fileLines.map(norm);

  const sameSide = (l: Pick<CodeLine, "kind">) =>
    l.kind === "elided" || sideOf(anchor.revision, l.kind) === side;
  const collect = (from: number, step: 1 | -1): (string | null)[] => {
    const out: (string | null)[] = [];
    for (let i = from; i >= 0 && i < anchor.lines.length && out.length < NEIGHBOURS; i += step) {
      const l = anchor.lines[i];
      if (!sameSide(l)) continue;
      if (l.kind === "elided") break;
      out.push(norm(l.text));
    }
    return out;
  };
  const before = collect(anchor.index - 1, -1);
  const after = collect(anchor.index + 1, 1);

  const needle = norm(target.text);
  let best: number | null = null;
  let bestScore = -1;
  for (let p = 0; p < file.length; p++) {
    if (file[p] !== needle) continue;
    let score = 0;
    before.forEach((t, k) => { if (file[p - 1 - k] === t) score++; });
    after.forEach((t, k) => { if (file[p + 1 + k] === t) score++; });
    if (score > bestScore) {
      best = p + 1;
      bestScore = score;
    }
  }
  return best;
}
