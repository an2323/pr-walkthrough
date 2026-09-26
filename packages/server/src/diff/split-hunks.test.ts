import { describe, it, expect } from "vitest";
import { splitDiffHunks, buildHunkPatch } from "./split-hunks.js";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -8,3 +8,3 @@ function f() {",
  "   const x = 1;",
  "-  const y = 2;",
  "+  const y = 3;",
  "   return x + y;",
  "@@ -20,2 +20,1 @@ function g() {",
  "-  return 1;",
  "   return 2;",
  "diff --git a/src/b.ts b/src/b.ts",
  "new file mode 100644",
  "index 000..333",
  "--- /dev/null",
  "+++ b/src/b.ts",
  "@@ -0,0 +1,1 @@",
  "+export const b = 1;",
].join("\n");

describe("splitDiffHunks", () => {
  it("ids each hunk file#index and keeps its body", () => {
    const hunks = splitDiffHunks(DIFF);
    expect(hunks.map((h) => h.id)).toEqual(["src/a.ts#1", "src/a.ts#2", "src/b.ts#1"]);
    expect(hunks[0].body).toEqual(["   const x = 1;", "-  const y = 2;", "+  const y = 3;", "   return x + y;"]);
    expect(hunks[0].newFile).toBe(false);
    expect(hunks[2].newFile).toBe(true);
  });

  it("builds a standalone patch per hunk", () => {
    const hunks = splitDiffHunks(DIFF);
    const patch = buildHunkPatch(hunks[1]);
    expect(patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(patch).toContain("@@ -20,2 +20,1 @@");
    expect(patch.endsWith("\n")).toBe(true);
  });

  it("marks a new file's patch with /dev/null on the old side", () => {
    const hunks = splitDiffHunks(DIFF);
    const patch = buildHunkPatch(hunks[2]);
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/src/b.ts");
  });
});
