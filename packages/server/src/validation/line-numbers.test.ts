import { describe, it, expect } from "vitest";
import type { WalkthroughDraft } from "../analyzer/interface.js";
import type { RepoWorkspace } from "../git/workspace.js";
import { annotateLines } from "./line-numbers.js";

const BASE_FILE = ["line1", "line2", "removed-me", "line4", "line5"].join("\n");
const HEAD_FILE = ["line1", "line2", "added-me", "line4", "line5"].join("\n");

const DIFF = [
  "diff --git a/f.ts b/f.ts",
  "index 111..222 100644",
  "--- a/f.ts",
  "+++ b/f.ts",
  "@@ -1,5 +1,5 @@",
  " line1",
  " line2",
  "-removed-me",
  "+added-me",
  " line4",
  " line5",
].join("\n");

function fakeWorkspace(): RepoWorkspace {
  return {
    repoPath: "/fake",
    baseSha: "base",
    headSha: "head",
    async readFile(_file: string, revision: "base" | "head") {
      return revision === "base" ? BASE_FILE : HEAD_FILE;
    },
    async diff() {
      return DIFF;
    },
  };
}

function draftWithBlock(lines: WalkthroughDraft["steps"][number]["beats"][number]["code"]) {
  return {
    steps: [
      {
        id: "s1",
        kind: "change",
        title: "t",
        headline: "h",
        say: "s",
        narration: "n",
        tag: "fact",
        beats: [{ code: lines }],
      },
    ],
  } as unknown as WalkthroughDraft;
}

describe("annotateLines", () => {
  it("numbers lines and marks the removed/added ones from the diff", async () => {
    const draft = draftWithBlock([
      {
        file: "f.ts",
        revision: "diff",
        lines: [
          { kind: "context", text: "line2" },
          { kind: "removed", text: "removed-me" },
          { kind: "added", text: "added-me" },
          { kind: "context", text: "line4" },
        ],
      },
    ]);

    const errors = await annotateLines(draft, fakeWorkspace(), DIFF);
    expect(errors).toEqual([]);

    const lines = draft.steps[0].beats[0].code![0].lines;
    expect(lines[0]).toMatchObject({ n: 2 }); // "line2" on HEAD, unchanged
    expect(lines[0].change).toBeUndefined();
    expect(lines[1]).toMatchObject({ n: 3, change: "removed" }); // BASE line 3
    expect(lines[2]).toMatchObject({ n: 3, change: "added" }); // HEAD line 3
    expect(lines[3]).toMatchObject({ n: 4 });
    expect(lines[3].change).toBeUndefined();
  });

  it("does not mark an unchanged line even if its neighbour changed", async () => {
    const draft = draftWithBlock([
      { file: "f.ts", revision: "base", lines: [{ kind: "focus", text: "line4" }] },
    ]);
    await annotateLines(draft, fakeWorkspace(), DIFF);
    const line = draft.steps[0].beats[0].code![0].lines[0];
    expect(line.n).toBe(4);
    expect(line.change).toBeUndefined();
  });

  it("skips elided lines (no n, resets the contiguity chain)", async () => {
    const draft = draftWithBlock([
      {
        file: "f.ts",
        revision: "base",
        lines: [
          { kind: "context", text: "line1" },
          { kind: "elided", text: "…" },
          { kind: "context", text: "line5" },
        ],
      },
    ]);
    const errors = await annotateLines(draft, fakeWorkspace(), DIFF);
    expect(errors).toEqual([]);
    const lines = draft.steps[0].beats[0].code![0].lines;
    expect(lines[0].n).toBe(1);
    expect(lines[1].n).toBeUndefined();
    expect(lines[2].n).toBe(5);
  });

  it("does not flag a skipped blank spacer line as stitching", async () => {
    // BASE_FILE has no blank line, so add one via a dedicated fixture inline.
    const withBlank = ["a", "", "b"].join("\n");
    const ws: RepoWorkspace = { ...fakeWorkspace(), async readFile() { return withBlank; } };
    const draft = draftWithBlock([
      {
        file: "f.ts",
        revision: "base",
        lines: [
          { kind: "context", text: "a" },
          { kind: "context", text: "b" },
        ],
      },
    ]);
    const errors = await annotateLines(draft, ws, DIFF);
    expect(errors).toEqual([]);
  });

  it("flags two same-side lines quoted as adjacent when the file skips one between them", async () => {
    // line2 (n=2) then line4 (n=4) with nothing marking the gap — line3 was silently dropped.
    const draft = draftWithBlock([
      {
        file: "f.ts",
        revision: "base",
        lines: [
          { kind: "context", text: "line2" },
          { kind: "context", text: "line4" },
        ],
      },
    ]);
    const errors = await annotateLines(draft, fakeWorkspace(), DIFF);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not adjacent/);
  });

  it("does not compare across sides in a diff block (removed then added is normal)", async () => {
    const draft = draftWithBlock([
      {
        file: "f.ts",
        revision: "diff",
        lines: [
          { kind: "removed", text: "removed-me" },
          { kind: "added", text: "added-me" },
        ],
      },
    ]);
    const errors = await annotateLines(draft, fakeWorkspace(), DIFF);
    expect(errors).toEqual([]);
  });

  it("skips reconstructed blocks entirely", async () => {
    const draft = draftWithBlock([
      { file: "f.ts", revision: "base", reconstructed: true, lines: [{ kind: "context", text: "made-up-line" }] },
    ]);
    const errors = await annotateLines(draft, fakeWorkspace(), DIFF);
    expect(errors).toEqual([]);
    expect(draft.steps[0].beats[0].code![0].lines[0].n).toBeUndefined();
  });
});
