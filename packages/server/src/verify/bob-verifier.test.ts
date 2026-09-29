import { describe, it, expect } from "vitest";
import type { Walkthrough } from "@pr-walkthrough/shared";

import { buildPrompt, diffBlock } from "./bob-verifier.js";
import { recipeFor } from "./recipes.js";

const recipe = recipeFor("excalidraw", "excalidraw")!;

function wt(overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    schemaVersion: 1,
    pr: { repo: "excalidraw/excalidraw", number: 1, title: "A fix", url: "u", author: "a", filesChanged: 1, additions: 1, deletions: 1, commitTitles: [] },
    summary: { problem: "p", solution: "s" },
    hunks: [{ id: "src/a.ts#1", file: "src/a.ts", header: "@@", added: 1, removed: 1 }],
    graph: { nodes: [], edges: [] },
    steps: [],
    skippedHunks: [],
    openQuestions: [],
    coverage: { totalHunks: 1, explained: 1, skipped: 0, uncoveredHunkIds: [] },
    meta: { analyzer: "manual", generatedAt: "2026-01-01T00:00:00Z", language: "en" },
    ...overrides,
  } as Walkthrough;
}

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old line",
  "+new line",
  "diff --git a/src/a.test.ts b/src/a.test.ts",
  "--- a/src/a.test.ts",
  "+++ b/src/a.test.ts",
  "@@ -1 +1 @@",
  "-test old",
  "+test new",
  "",
].join("\n");

describe("diffBlock", () => {
  it("shows the real change and leaves tests out", () => {
    const b = diffBlock(DIFF);
    expect(b).toContain("+new line");
    expect(b).not.toContain("test new");
    expect(b.startsWith("```diff")).toBe(true);
  });

  it("trims a long diff and says where the rest is", () => {
    const big = "diff --git a/x.ts b/x.ts\n" + "+line of code\n".repeat(2000);
    const b = diffBlock(big, 500);
    expect(b.length).toBeLessThan(700);
    expect(b).toContain("trimmed");
    expect(b).toContain(".walkthrough/pr.diff");
  });

  it("points at the file when there is no diff", () => {
    expect(diffBlock("")).toContain(".walkthrough/pr.diff");
  });
});

describe("buildPrompt", () => {
  const prompt = buildPrompt(wt(), recipe, "http://127.0.0.1:1/", "http://127.0.0.1:2/", DIFF);

  it("inlines the change so Bob doesn't pay to discover it", () => {
    expect(prompt).toContain("## The change itself");
    expect(prompt).toContain("+new line");
  });

  it("asks for one scenario per visible problem, each ending in a state that shows on screen", () => {
    expect(prompt).toMatch(/one scenario per visible problem/i);
    expect(prompt).toMatch(/scenarios\.json/);
    expect(prompt).toMatch(/ENDS in a state where the\s+problem is visible on screen/);
    expect(prompt).toMatch(/BASE and HEAD would look the same, you picked a\s+state that does not show the problem/);
  });

  it("no longer pushes Bob toward invisible signals (a value that leaves both screenshots identical)", () => {
    expect(prompt).not.toMatch(/cheapest reliable signal/);
    expect(prompt).not.toMatch(/computed\s+style of the element that uses it/);
    expect(prompt).toMatch(/not from a value that\s+leaves both screenshots identical/);
  });

  it("forbids reporting 'false' when the scenario never ran (a found-nothing script is a failed script)", () => {
    expect(prompt).toMatch(/only say .*bugPresent: false.* after the scenario actually ran/s);
    expect(prompt).toMatch(/exit\s+non-zero/);
    expect(prompt).toMatch(/"Not found" is a failed script, not a fixed bug/);
  });

  it("tells Bob to write the scripts first and never leave a probe unsaved (what cost $2 in the first live run)", () => {
    expect(prompt).toMatch(/write the scripts FIRST/);
    expect(prompt).toMatch(/a probe\s+is worth nothing until it is in a script/);
  });

  it("keeps the hard limits: three runs per script, then drop it", () => {
    expect(prompt).toMatch(/At most 3 runs of any one script/);
    expect(prompt).toMatch(/drop it from scenarios\.json/);
  });

  it("carries the app's own tips from the recipe — only selectors that were observed on the app", () => {
    expect(prompt).toContain("## App tips");
    expect(prompt).toContain("main-menu-trigger");
    expect(prompt).toContain(".sidebar-trigger__label-element");
    // `.App-top-bar` does not exist in this build (probe: topBarExists false) — the hint must say so, not send Bob to it.
    expect(prompt).toMatch(/no `\.App-top-bar` element/);
  });

  it("never carries secrets", () => {
    for (const k of ["DATABASE_URL", "SERVICE_ROLE", "BOB_API_KEY"]) expect(prompt).not.toContain(k);
  });
});

describe("buildPrompt — highlight rules (the agreed reference look)", () => {
  const wt = { pr: { title: "t" }, hunks: [], steps: [], plain: {} } as never;
  const recipe = { viewport: { width: 1280, height: 800 }, hints: "" } as never;
  const p = buildPrompt(wt, recipe, "http://b/", "http://h/");

  it("boxes are the whole element, never a slice", () => {
    expect(p).toMatch(/WHOLE element/);
    expect(p).toMatch(/getBoundingClientRect/);
    expect(p).toMatch(/do not cap its height/);
  });
  it("phone scripts return no highlights and use a 2x scale factor", () => {
    expect(p).toMatch(/"highlights": \[\]/);
    expect(p).toMatch(/deviceScaleFactor: 2/);
  });
  it("the main picture stays a desktop frame; gone elements are described without coordinates", () => {
    expect(p).toMatch(/main before\/after picture is ALWAYS a desktop frame/);
    expect(p).toMatch(/"gone": true/);
  });
});
