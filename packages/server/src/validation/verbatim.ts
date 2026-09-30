/**
 * verbatim.ts — verify that every quoted CodeLine exists verbatim in the
 * referenced file at the specified revision.
 */

import type { WalkthroughDraft } from "../analyzer/interface.js";
import type { RepoWorkspace } from "../git/workspace.js";

export interface VerbatimResult {
  valid: boolean;
  /** "step s1 beat 0 block 0 line 3: expected '...' not found in base file Foo.tsx" */
  errors: string[];
  /** Quotes replaced by the real line they were a near-miss of (see `nearestLine`). */
  snapped: string[];
}

/** Edit distance, stopping early once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
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

/**
 * The one real line a quote is a near-miss of — or undefined. Seen live on #12053: Bob quoted
 * "}, [callbacksRef, open, menuNode];" for "}, [callbacksRef, open, menuNode]);" (one dropped
 * parenthesis), twice, through its own repair; the byte-exact check threw the whole walkthrough away.
 * Only a tiny difference (≤ 2 characters, or 5% of a long line), the same indentation, and a single
 * closest candidate qualify — anything less certain stays an error.
 */
export function nearestLine(needle: string, lines: Iterable<string>): string | undefined {
  const max = Math.max(2, Math.floor(needle.length * 0.05));
  const indent = needle.match(/^\s*/)![0];
  let best: string | undefined;
  let bestD = max + 1;
  let tie = false;
  for (const l of lines) {
    if (!l.trim() || !l.startsWith(indent) || /^\s/.test(l.slice(indent.length)) !== /^\s/.test(needle.slice(indent.length))) continue;
    const d = editDistance(needle, l, max);
    if (d < bestD) {
      bestD = d;
      best = l;
      tie = false;
    } else if (d === bestD && l !== best) {
      tie = true;
    }
  }
  return best !== undefined && bestD <= max && !tie ? best : undefined;
}

/**
 * For each Step → Beat → CodeBlock where `reconstructed !== true`:
 *  - Read the file at the appropriate revision ("diff" → "head").
 *  - For each CodeLine where `kind !== "elided"`: confirm that `line.text`
 *    (trailing whitespace stripped) matches at least one line in the file
 *    (also trailing-stripped).
 */
export async function checkVerbatim(
  draft: WalkthroughDraft,
  workspace: RepoWorkspace
): Promise<VerbatimResult> {
  const errors: string[] = [];
  const snapped: string[] = [];

  // Cache file contents keyed by "revision:file" to avoid redundant git reads.
  const fileCache = new Map<string, Set<string>>();

  async function getLines(
    file: string,
    revision: "base" | "head"
  ): Promise<Set<string>> {
    const key = `${revision}:${file}`;
    const cached = fileCache.get(key);
    if (cached) return cached;

    let content: string;
    try {
      content = await workspace.readFile(file, revision);
    } catch {
      // File may not exist at this revision (e.g. new file at head).
      // Return empty set — every line check will fail with a clear message.
      fileCache.set(key, new Set());
      return fileCache.get(key)!;
    }

    // Normalise CRLF → LF, then build a set of trailing-stripped lines.
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const lineSet = new Set(lines.map((l) => l.trimEnd()));
    fileCache.set(key, lineSet);
    return lineSet;
  }

  for (const step of draft.steps) {
    for (let bi = 0; bi < step.beats.length; bi++) {
      const beat = step.beats[bi];
      if (!beat.code) continue;

      for (let ci = 0; ci < beat.code.length; ci++) {
        const block = beat.code[ci];

        // Reconstructed blocks are exempt — they are not in any revision.
        if (block.reconstructed === true) continue;

        // A whole block quoted from the OTHER revision of the same file: the code is real, only the label
        // is wrong (#12053: a BASE-only line in a block marked "head"). Relabel it instead of failing.
        if (block.revision === "base" || block.revision === "head") {
          const own = await getLines(block.file, block.revision);
          const other = block.revision === "base" ? "head" : "base";
          const quoted = block.lines.filter((l) => l.kind !== "elided").map((l) => l.text.trimEnd());
          if (quoted.length > 0 && quoted.some((t) => !own.has(t))) {
            const otherLines = await getLines(block.file, other);
            const baseLines = await getLines(block.file, "base");
            const headLines = await getLines(block.file, "head");
            const real = block.lines.filter((l) => l.kind !== "elided");
            // A block with removed/added lines IS a diff: removed lines from BASE, the rest from HEAD.
            const isDiff = real.some((l) => l.kind === "removed" || l.kind === "added") &&
              real.every((l) => (l.kind === "removed" ? baseLines : headLines).has(l.text.trimEnd()));
            if (quoted.every((t) => otherLines.has(t))) {
              snapped.push(`step ${step.id} beat ${bi} block ${ci}: quoted from ${other}, labelled ${block.revision} → relabelled`);
              block.revision = other;
            } else if (isDiff) {
              snapped.push(`step ${step.id} beat ${bi} block ${ci}: removed/added lines labelled ${block.revision} → relabelled diff`);
              (block as { revision: string }).revision = "diff";
            }
          }
        }

        for (let li = 0; li < block.lines.length; li++) {
          const line = block.lines[li];

          // Elided lines are placeholders, not actual source text.
          if (line.kind === "elided") continue;

          // Determine which revision to look up:
          //  - "base" / "head" blocks: straightforward.
          //  - "diff" blocks: removed lines only existed in base; added/context/focus
          //    lines should be present in head.
          let revision: "base" | "head";
          if (block.revision === "diff") {
            revision = line.kind === "removed" ? "base" : "head";
          } else {
            revision = block.revision;
          }

          const lineSet = await getLines(block.file, revision);
          const needle = line.text.trimEnd();

          if (!lineSet.has(needle)) {
            // A near-miss of exactly one real line is corrected to it (mutates the draft, like
            // line-numbers.ts does): the walkthrough then quotes the real code.
            const real = nearestLine(needle, lineSet);
            if (real !== undefined) {
              snapped.push(`step ${step.id} beat ${bi} block ${ci} line ${li}: ${JSON.stringify(needle)} → ${JSON.stringify(real)}`);
              line.text = real;
              continue;
            }
            errors.push(
              `step ${step.id} beat ${bi} block ${ci} line ${li}: ` +
                `expected ${JSON.stringify(line.text)} not found in ` +
                `${block.revision} file ${block.file}`
            );
          }
        }
      }
    }
  }

  if (snapped.length > 0) console.log(`[verbatim] corrected ${snapped.length} near-miss quote(s):\n  ${snapped.join("\n  ")}`);
  return { valid: errors.length === 0, errors, snapped };
}
