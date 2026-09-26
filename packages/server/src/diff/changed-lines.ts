/**
 * diff/changed-lines.ts — which exact lines a unified diff added or removed,
 * per file and 1-based line number in that revision. Used by
 * validation/line-numbers.ts to mark a quoted CodeLine `change: "added" |
 * "removed"` independent of the analyzer's own `kind` judgement.
 *
 * `parseHunks` (shared) only counts added/removed lines per hunk for the hunk
 * id/coverage system — it doesn't keep the actual line numbers, so this is a
 * second, small parse of the same raw diff text for a different purpose.
 */

export interface FileChangedLines {
  /** 1-based line numbers in the HEAD file that the PR added. */
  added: Set<number>;
  /** 1-based line numbers in the BASE file that the PR removed. */
  removed: Set<number>;
}

const FILE_HEADER = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a full multi-file unified diff (`git diff base...head` output). */
export function parseDiffChangedLines(diff: string): Map<string, FileChangedLines> {
  const out = new Map<string, FileChangedLines>();
  let file: FileChangedLines | undefined;
  let oldLn = 0;
  let newLn = 0;

  for (const raw of diff.split("\n")) {
    const fileMatch = FILE_HEADER.exec(raw);
    if (fileMatch) {
      const path = fileMatch[1];
      // "/dev/null" (a deleted file) has no HEAD side to number — skip it.
      file = path === "/dev/null" ? undefined : { added: new Set(), removed: new Set() };
      if (file) out.set(path, file);
      continue;
    }
    if (raw.startsWith("diff --git ") || raw.startsWith("--- ")) {
      file = undefined; // between files, or the old-path header — wait for +++
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(raw);
    if (hunkMatch) {
      oldLn = parseInt(hunkMatch[1], 10);
      newLn = parseInt(hunkMatch[2], 10);
      continue;
    }
    if (!file) continue; // outside any hunk (e.g. the diff --git/index lines) or a binary/deleted file
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      file.added.add(newLn++);
    } else if (raw.startsWith("-")) {
      file.removed.add(oldLn++);
    } else if (raw.startsWith(" ") || raw === "") {
      oldLn++;
      newLn++;
    }
    // Any other line (e.g. "Binary files ... differ") is ignored.
  }
  return out;
}
