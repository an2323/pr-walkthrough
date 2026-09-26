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

  return { valid: errors.length === 0, errors };
}
