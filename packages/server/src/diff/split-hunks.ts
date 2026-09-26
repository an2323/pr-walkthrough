/**
 * diff/split-hunks.ts — split a unified diff into individually-appliable
 * hunks, for the ablation runner (verify/ablation.ts): applying a chosen
 * SUBSET of a PR's hunks to a BASE checkout to see which ones the fix
 * actually needs.
 *
 * Ids match `parseHunks` (shared package): `${file}#${1-based index in file}`.
 *
 * Each hunk is kept as a fully standalone single-hunk patch (its own
 * `diff --git`/`---`/`+++` header + its own body) rather than trying to
 * reconstruct one combined multi-hunk file patch. This isn't a shortcut:
 * `git apply`'s hunk-matching is context/old-line-number driven and tolerates
 * small offsets from hunks already applied earlier in the same run — the
 * same mechanism it uses internally for any ordinary multi-hunk diff — so
 * applying hunks one at a time, in file order, is exactly equivalent and
 * much simpler to get right than hand-recomputing new-side line numbers for
 * a combined patch (confirmed empirically: a hunk's OLD-side numbers are
 * absolute against the base file and apply correctly standalone regardless
 * of which other hunks from the same file are included or excluded).
 */

export interface DiffHunk {
  id: string;
  file: string;
  /** True if this file was newly created by the PR (no base version). */
  newFile: boolean;
  /** True if this file was deleted by the PR (no head version). */
  deletedFile: boolean;
  /** The "@@ -a,b +c,d @@ ..." line, verbatim. */
  header: string;
  /** Body lines (context/+/-), NOT including the header. */
  body: string[];
  oldStart: number;
}

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_HEADER = /^--- (?:a\/(.+)|\/dev\/null)$/;
const NEW_HEADER = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** Split a full multi-file unified diff into standalone-appliable hunks. */
export function splitDiffHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let file: string | undefined;
  let newFile = false;
  let deletedFile = false;
  let index = 0; // 1-based hunk index within the current file, matches parseHunks
  let current: DiffHunk | undefined;

  const flush = (): void => {
    if (current) out.push(current);
    current = undefined;
  };

  for (const raw of diff.split("\n")) {
    const gitMatch = DIFF_GIT.exec(raw);
    if (gitMatch) {
      flush();
      file = gitMatch[2];
      newFile = false;
      deletedFile = false;
      index = 0;
      continue;
    }
    if (OLD_HEADER.exec(raw)) {
      newFile = raw === "--- /dev/null";
      continue;
    }
    if (NEW_HEADER.exec(raw)) {
      deletedFile = raw === "+++ /dev/null";
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(raw);
    if (hunkMatch && file) {
      flush();
      index++;
      current = {
        id: `${file}#${index}`,
        file,
        newFile,
        deletedFile,
        header: raw,
        body: [],
        oldStart: parseInt(hunkMatch[1], 10),
      };
      continue;
    }
    if (current && (raw.startsWith(" ") || raw.startsWith("+") || raw.startsWith("-") || raw.startsWith("\\") || raw === "")) {
      current.body.push(raw);
    }
    // Anything else (index lines, "Binary files ... differ", etc.) is ignored.
  }
  flush();
  return out;
}

/** A standalone patch `git apply` can take for exactly this one hunk. */
export function buildHunkPatch(hunk: DiffHunk): string {
  const oldPath = hunk.newFile ? "/dev/null" : `a/${hunk.file}`;
  const newPath = hunk.deletedFile ? "/dev/null" : `b/${hunk.file}`;
  return (
    [`diff --git a/${hunk.file} b/${hunk.file}`, `--- ${oldPath}`, `+++ ${newPath}`, hunk.header, ...hunk.body].join(
      "\n"
    ) + "\n"
  );
}
