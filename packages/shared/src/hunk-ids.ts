/**
 * hunk-ids.ts — parse unified diff text into Hunk[] with stable `file#n` ids.
 *
 * Stable id format: `${file}#${1-based hunk index within file}`
 * e.g. "app/components/Foo.tsx#1", "app/components/Foo.tsx#2"
 */

import type { Hunk } from "./walkthrough.js";

/**
 * Parse a unified diff string (output of `git diff`) into a Hunk array.
 * Assigns stable ids of the form `${file}#${index}`.
 */
export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let currentFile: string | null = null;
  let hunkIndexInFile = 0;

  const lines = diffText.split("\n");
  for (const line of lines) {
    // Reset file tracking on each new diff --git header
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      hunkIndexInFile = 0;
      continue;
    }

    // Binary files line — skip, no hunk emitted for this file
    if (line.startsWith("Binary files ")) {
      currentFile = null;
      continue;
    }

    // "+++ b/path" → new file header (renamed files use the b/ path automatically)
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      hunkIndexInFile = 0;
      continue;
    }

    // "+++ /dev/null" → deleted file, no hunks to emit
    if (line.startsWith("+++ /dev/null")) {
      currentFile = null;
      continue;
    }

    // Hunk header: "@@ -old,count +new,count @@ optional context"
    if (line.startsWith("@@") && currentFile) {
      hunkIndexInFile += 1;
      hunks.push({
        id: hunkId(currentFile, hunkIndexInFile),
        file: currentFile,
        header: line,
        added: 0,
        removed: 0,
      });
      continue;
    }

    // Count +/- lines into the last open hunk for this file
    if (hunks.length > 0 && currentFile) {
      const last = hunks[hunks.length - 1];
      if (last.file === currentFile) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          last.added += 1;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          last.removed += 1;
        }
      }
    }
  }

  return hunks;
}

/** Produce the stable hunk id for a file and 1-based hunk index. */
export function hunkId(file: string, index: number): string {
  return `${file}#${index}`;
}
