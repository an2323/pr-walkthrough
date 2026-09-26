/**
 * hunk-ids.test.ts — unit tests for parseHunks from @pr-walkthrough/shared.
 *
 * Test cases:
 *  1. Simple inline diff: 2 files, 3 hunks — verify ids, added/removed counts
 *  2. Binary file diff — verify no hunk emitted for the binary file
 *  3. Golden PR diff: outline/outline@70ef12b — verify all 13 hunk ids from
 *     docs/bob-brief/examples/outline-13673.walkthrough.json are present.
 */

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseHunks } from "@pr-walkthrough/shared";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 1. Simple inline diff — 2 files, 3 hunks
// ---------------------------------------------------------------------------
const SIMPLE_DIFF = `\
diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,6 @@ function foo() {
 context line
-removed line
+added line 1
+added line 2
 context line
 context line
@@ -20,4 +21,3 @@ function bar() {
 context line
-removed again
 context line
diff --git a/src/bar.ts b/src/bar.ts
index 3333333..4444444 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,3 +10,4 @@ export function bar() {
 context
+new line
 context
`;

describe("parseHunks — simple inline diff", () => {
  it("returns 3 hunks with correct ids", () => {
    const hunks = parseHunks(SIMPLE_DIFF);
    expect(hunks).toHaveLength(3);
    expect(hunks[0].id).toBe("src/foo.ts#1");
    expect(hunks[1].id).toBe("src/foo.ts#2");
    expect(hunks[2].id).toBe("src/bar.ts#1");
  });

  it("correctly counts added/removed lines", () => {
    const hunks = parseHunks(SIMPLE_DIFF);
    // hunk 1: -1 removed, +2 added
    expect(hunks[0].added).toBe(2);
    expect(hunks[0].removed).toBe(1);
    // hunk 2: -1 removed, +0 added
    expect(hunks[1].added).toBe(0);
    expect(hunks[1].removed).toBe(1);
    // hunk 3: +1 added, -0 removed
    expect(hunks[2].added).toBe(1);
    expect(hunks[2].removed).toBe(0);
  });

  it("records the correct file for each hunk", () => {
    const hunks = parseHunks(SIMPLE_DIFF);
    expect(hunks[0].file).toBe("src/foo.ts");
    expect(hunks[1].file).toBe("src/foo.ts");
    expect(hunks[2].file).toBe("src/bar.ts");
  });
});

// ---------------------------------------------------------------------------
// 2. Binary file diff — no hunks for the binary file
// ---------------------------------------------------------------------------
const BINARY_DIFF = `\
diff --git a/src/real.ts b/src/real.ts
index 1111111..2222222 100644
--- a/src/real.ts
+++ b/src/real.ts
@@ -1,3 +1,4 @@ export function x() {
 context
+new line
 context
diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/src/after.ts b/src/after.ts
index 3333333..4444444 100644
--- a/src/after.ts
+++ b/src/after.ts
@@ -5,3 +5,4 @@ export function y() {
 context
+added
 context
`;

describe("parseHunks — binary file", () => {
  it("emits no hunk for the binary file", () => {
    const hunks = parseHunks(BINARY_DIFF);
    const files = hunks.map((h) => h.file);
    expect(files).not.toContain("assets/logo.png");
  });

  it("still emits hunks for text files around the binary file", () => {
    const hunks = parseHunks(BINARY_DIFF);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].id).toBe("src/real.ts#1");
    expect(hunks[1].id).toBe("src/after.ts#1");
  });
});

// ---------------------------------------------------------------------------
// 3. Golden PR diff: outline/outline PR #13673 (70ef12b)
// ---------------------------------------------------------------------------

// All 13 hunk ids listed in outline-13673.walkthrough.json
const GOLDEN_HUNK_IDS = [
  "app/components/DocumentContext.tsx#1",
  "app/components/DocumentContext.tsx#2",
  "app/scenes/Document/components/ChangesNavigation.tsx#1",
  "app/scenes/Document/components/ChangesNavigation.tsx#2",
  "app/scenes/Document/components/Document.tsx#1",
  "app/scenes/Document/components/Header.tsx#1",
  "app/scenes/Document/components/Header.tsx#2",
  "app/scenes/Document/components/Header.tsx#3",
  "app/scenes/Document/components/Header.tsx#4",
  "app/scenes/Document/components/RevisionViewer.tsx#1",
  "app/scenes/Document/components/RevisionViewer.tsx#2",
  "shared/editor/extensions/Diff.ts#1",
  "shared/editor/extensions/Diff.ts#2",
];

const CACHE_DIR =
  process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";

const REPO_URL = "https://github.com/outline/outline";
const REPO_NAME = "outline__outline";
const REPO_PATH = path.join(CACHE_DIR, REPO_NAME);
const HEAD_SHA = "70ef12b";

async function ensureOutlineRepo(): Promise<void> {
  if (existsSync(path.join(REPO_PATH, ".git"))) {
    return; // already cloned
  }
  await execFileAsync(
    "git",
    ["clone", "--quiet", "--filter=blob:none", REPO_URL, REPO_PATH],
    { timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
  );
}

describe("parseHunks — golden PR diff (outline/outline#13673)", () => {
  it(
    "produces all 13 expected hunk ids",
    async () => {
      await ensureOutlineRepo();

      const { stdout: diffText } = await execFileAsync(
        "git",
        ["diff", `${HEAD_SHA}^...${HEAD_SHA}`],
        { cwd: REPO_PATH, maxBuffer: 64 * 1024 * 1024 }
      );

      const hunks = parseHunks(diffText);
      const parsedIds = new Set(hunks.map((h) => h.id));

      for (const id of GOLDEN_HUNK_IDS) {
        expect(
          parsedIds.has(id),
          `Expected hunk id "${id}" to be present. Got: ${[...parsedIds].join(", ")}`
        ).toBe(true);
      }

      expect(hunks).toHaveLength(GOLDEN_HUNK_IDS.length);
    },
    10 * 60 * 1000 // 10 min — first run may need to clone
  );
});
