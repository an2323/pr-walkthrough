/**
 * anchor.ts — the code a walkthrough shows is always the real code of the PR.
 *
 * Bob writes each quoted line itself, and it is sometimes a character off (a dropped parenthesis on
 * #12053, twice). The exact check used to throw the whole walkthrough away for that. Here Bob's text
 * is only a POINTER: each quoted line is located in the file of the revision the block names, and the
 * real line from the file replaces it. Nothing is shown that isn't in that revision:
 *  - a line is looked up only in its own revision (removed lines at BASE; added/context/focus lines at
 *    HEAD in a diff block; the block's revision otherwise) — "before" code is never shown as "after";
 *  - a block whose lines are removed/added lines is a diff, whatever Bob labelled it (both sides stay
 *    labelled as what they are);
 *  - a line with no confident match becomes "…" (its annotation stays under it);
 *  - a block where fewer than half the lines match is dropped, and its line annotations move to the
 *    step's notes — the explanation stays, only unverifiable code goes.
 * Bob's annotations, kinds and labels stay on their lines.
 */

import type { WalkthroughDraft } from "../analyzer/interface.js";
import type { RepoWorkspace } from "../git/workspace.js";

type Rev = "base" | "head";

export interface AnchorReport {
  /** Lines whose text was replaced by the real line. */
  corrected: string[];
  /** Lines that became "…". */
  elided: string[];
  /** Blocks that were removed. */
  dropped: string[];
}

/** Edit distance, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Index of the file line that `needle` quotes, searching from `from` onward (quotes run top to bottom).
 * Exact first, then the same text with different spacing, then the single closest line within a
 * couple of characters (5% of a long line). Ambiguous → undefined.
 */
export function locate(needle: string, file: string[], from = 0): number | undefined {
  const exact = file.findIndex((l, i) => i >= from && l.trimEnd() === needle.trimEnd());
  if (exact >= 0) return exact;
  const sq = squash(needle);
  if (!sq) return undefined;
  const spaced = file.map((l, i) => (i >= from && squash(l) === sq ? i : -1)).filter((i) => i >= 0);
  if (spaced.length === 1) return spaced[0];
  if (spaced.length > 1) return spaced[0]; // same text repeated: the next one in reading order
  const max = Math.max(2, Math.floor(sq.length * 0.05));
  let best = -1;
  let bestD = max + 1;
  let tie = false;
  for (let i = from; i < file.length; i++) {
    const cand = squash(file[i]);
    if (!cand) continue;
    const d = editDistance(sq, cand, max);
    if (d > max) continue;
    if (d < bestD) {
      bestD = d;
      best = i;
      tie = false;
    } else if (d === bestD && cand !== squash(file[best])) {
      tie = true;
    }
  }
  return best >= 0 && bestD <= max && !tie ? best : undefined;
}

export async function anchorQuotes(draft: WalkthroughDraft, workspace: RepoWorkspace): Promise<AnchorReport> {
  const report: AnchorReport = { corrected: [], elided: [], dropped: [] };
  const cache = new Map<string, string[] | null>();
  const fileLines = async (file: string, rev: Rev): Promise<string[] | null> => {
    const key = `${rev}:${file}`;
    if (!cache.has(key)) {
      try {
        cache.set(key, (await workspace.readFile(file, rev)).replace(/\r\n/g, "\n").split("\n"));
      } catch {
        cache.set(key, null);
      }
    }
    return cache.get(key)!;
  };

  for (const step of draft.steps) {
    for (let bi = 0; bi < step.beats.length; bi++) {
      const beat = step.beats[bi];
      if (!beat.code) continue;
      const keep: typeof beat.code = [];
      for (let ci = 0; ci < beat.code.length; ci++) {
        const block = beat.code[ci];
        const where = `${step.id} beat ${bi} block ${ci}`;
        if (block.reconstructed === true) {
          keep.push(block);
          continue;
        }
        const real = block.lines.filter((l) => l.kind !== "elided");
        // Removed/added lines make it a diff, whatever the label: each side stays what it is.
        if (block.revision !== "diff" && real.some((l) => l.kind === "removed" || l.kind === "added")) {
          (block as { revision: string }).revision = "diff";
        }
        const revOf = (kind: string): Rev =>
          block.revision === "diff" ? (kind === "removed" ? "base" : "head") : (block.revision as Rev);

        let matched = 0;
        const cursor: Record<Rev, number> = { base: 0, head: 0 };
        for (let li = 0; li < block.lines.length; li++) {
          const line = block.lines[li];
          if (line.kind === "elided") continue;
          const rev = revOf(line.kind);
          const file = await fileLines(block.file, rev);
          // Quotes run top to bottom; a line quoted out of order is still looked up from the top.
          const at = file ? (locate(line.text, file, cursor[rev]) ?? locate(line.text, file, 0)) : undefined;
          if (at === undefined) {
            report.elided.push(`${where} line ${li}: ${JSON.stringify(line.text)} (not in ${rev})`);
            block.lines[li] = { ...line, kind: "elided", text: "…" };
            continue;
          }
          matched++;
          cursor[rev] = at + 1;
          if (file![at].trimEnd() !== line.text.trimEnd()) {
            report.corrected.push(`${where} line ${li}: ${JSON.stringify(line.text)} → ${JSON.stringify(file![at].trimEnd())}`);
            line.text = file![at].trimEnd();
          }
        }
        if (real.length > 0 && matched * 2 < real.length) {
          report.dropped.push(`${where} (${block.file}, ${matched}/${real.length} lines found)`);
          const notes = block.lines.map((l) => l.annotation).filter((a): a is string => !!a);
          if (notes.length > 0) step.notes = [...(step.notes ?? []), ...notes];
          continue;
        }
        // Collapse runs of "…" (several unmatched lines in a row read as one gap).
        block.lines = block.lines.filter((l, i, all) => !(l.kind === "elided" && !l.annotation && all[i - 1]?.kind === "elided"));
        keep.push(block);
      }
      if (keep.length !== beat.code.length) {
        if (keep.length > 0) beat.code = keep;
        else delete beat.code;
      }
    }
  }
  const total = report.corrected.length + report.elided.length + report.dropped.length;
  if (total > 0) {
    console.log(
      `[anchor] quotes tied to the real files: ${report.corrected.length} corrected, ${report.elided.length} → "…", ${report.dropped.length} block(s) dropped` +
        [...report.corrected, ...report.elided, ...report.dropped].map((x) => `\n  ${x}`).join("")
    );
  }
  return report;
}
