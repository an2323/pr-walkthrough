import { describe, it, expect } from "vitest";
import { locateLine, commentableLines, sideOf, generalCommentBody, type CommentAnchor } from "./review.js";

describe("sideOf", () => {
  it("maps revisions and diff kinds to a side", () => {
    expect(sideOf("base", "context")).toBe("LEFT");
    expect(sideOf("head", "context")).toBe("RIGHT");
    expect(sideOf("diff", "removed")).toBe("LEFT");
    expect(sideOf("diff", "added")).toBe("RIGHT");
    expect(sideOf("diff", "context")).toBe("RIGHT");
  });
});

describe("locateLine", () => {
  const file = ["a", "  }", "b", "c", "  }", "d", ""];

  it("finds a unique line", () => {
    const anchor: CommentAnchor = { file: "f", revision: "head", lines: [{ kind: "focus", text: "d" }], index: 0 };
    expect(locateLine(file, anchor)).toBe(6);
  });

  it("disambiguates a repeated line by its neighbours", () => {
    const anchor: CommentAnchor = {
      file: "f",
      revision: "head",
      lines: [{ kind: "context", text: "c" }, { kind: "focus", text: "  }" }, { kind: "context", text: "d" }],
      index: 1,
    };
    expect(locateLine(file, anchor)).toBe(5);
  });

  it("ignores trailing whitespace and the other side's lines in a diff block", () => {
    const head = ["x", "new  ", "y"];
    const anchor: CommentAnchor = {
      file: "f",
      revision: "diff",
      lines: [{ kind: "context", text: "x" }, { kind: "removed", text: "old" }, { kind: "added", text: "new" }],
      index: 2,
    };
    expect(locateLine(head, anchor)).toBe(2);
  });

  it("returns null for missing or elided lines", () => {
    expect(locateLine(file, { revision: "head", lines: [{ kind: "focus", text: "zzz" }], index: 0 })).toBeNull();
    expect(locateLine(file, { revision: "head", lines: [{ kind: "elided", text: "…" }], index: 0 })).toBeNull();
  });
});

describe("commentableLines", () => {
  it("collects per-side line numbers inside hunks", () => {
    const patch = ["@@ -10,3 +10,3 @@ fn", " ctx", "-old", "+new", " ctx2", "\\ No newline at end of file"].join("\n");
    const { LEFT, RIGHT } = commentableLines(patch);
    expect([...LEFT]).toEqual([10, 11, 12]);
    expect([...RIGHT]).toEqual([10, 11, 12]);
  });

  it("handles multiple hunks and single-line headers", () => {
    const patch = ["@@ -1 +1,2 @@", " a", "+b", "@@ -40,2 +41 @@", "-c", " d"].join("\n");
    const { LEFT, RIGHT } = commentableLines(patch);
    expect([...LEFT]).toEqual([1, 40, 41]);
    expect([...RIGHT]).toEqual([1, 2, 41]);
  });
});

describe("generalCommentBody", () => {
  it("links to the line at the given sha and quotes it", () => {
    const body = generalCommentBody("Why?", { repo: "o/r", sha: "abc", file: "src/a.ts", line: 7, text: "  foo();" });
    expect(body).toContain("https://github.com/o/r/blob/abc/src/a.ts#L7");
    expect(body).toContain("`src/a.ts` line 7");
    expect(body).toContain("  foo();");
    expect(body.endsWith("Why?")).toBe(true);
  });
});
