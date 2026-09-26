import { describe, it, expect } from "vitest";
import { parseDiffChangedLines } from "./changed-lines.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -8,4 +8,4 @@ function f() {",
  "   const x = 1;",
  "-  const y = 2;",
  "+  const y = 3;",
  "   return x + y;",
  " }",
  "diff --git a/src/b.ts b/src/b.ts",
  "new file mode 100644",
  "index 000..333",
  "--- /dev/null",
  "+++ b/src/b.ts",
  "@@ -0,0 +1,2 @@",
  "+export const b = 1;",
  "+export const c = 2;",
].join("\n");

describe("parseDiffChangedLines", () => {
  it("numbers added/removed lines per file, base and head each keep their own numbering", () => {
    const m = parseDiffChangedLines(DIFF);
    const a = m.get("src/a.ts")!;
    // "const y = 2;" was line 9 in BASE (removed); "const y = 3;" is line 9 in HEAD (added).
    expect([...a.removed]).toEqual([9]);
    expect([...a.added]).toEqual([9]);
  });

  it("handles a wholly new file (no base side)", () => {
    const m = parseDiffChangedLines(DIFF);
    const b = m.get("src/b.ts")!;
    expect([...b.added]).toEqual([1, 2]);
    expect([...b.removed]).toEqual([]);
  });

  it("returns an empty map for an empty diff", () => {
    expect(parseDiffChangedLines("").size).toBe(0);
  });
});
