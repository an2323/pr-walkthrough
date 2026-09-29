/**
 * quality.test.ts — unit tests for the soft output-contract checks, plus a
 * sanity run against the real Outline golden JSON (docs/output-contract.md).
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Walkthrough, Step } from "@pr-walkthrough/shared";
import { checkQuality, criticalQualityWarnings } from "./quality.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../../");
const GOLDEN_JSON_PATH = path.join(
  WORKSPACE_ROOT,
  "docs/bob-brief/examples/outline-13673.walkthrough.json"
);

// ---------------------------------------------------------------------------
// Minimal valid fixture — every test starts from this and overrides one thing.
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: "s1",
    kind: "change",
    routeLabel: "Change",
    title: "A change",
    focusNode: "n1",
    tag: "fact",
    narration: "This changes how the value is stored, so the header can read it.",
    beats: [{
      kind: "change", heading: "What we change", text: "Moves the value.",
      code: [{ file: "a.ts", revision: "head", lines: [{ kind: "added", text: "const x = 1;" }] }],
    }],
    hunkIds: ["a.ts#1"],
    sources: [],
    ...overrides,
  };
}

function makeWalkthrough(overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    schemaVersion: 1,
    pr: {
      repo: "owner/repo", number: 1, title: "Fix thing", url: "https://github.com/owner/repo/pull/1",
      author: "someone", filesChanged: 1, additions: 1, deletions: 1, commitTitles: [],
    },
    summary: { problem: "Something broke.", solution: "We fixed it." },
    hunks: [{ id: "a.ts#1", file: "a.ts", header: "@@ -1,1 +1,1 @@", added: 1, removed: 1 }],
    graph: { nodes: [{ id: "n1", label: "A", kind: "file" }], edges: [] },
    steps: [makeStep()],
    skippedHunks: [],
    openQuestions: [],
    coverage: { totalHunks: 1, explained: 1, skipped: 0, uncoveredHunkIds: [] },
    meta: { analyzer: "manual", generatedAt: "2026-01-01T00:00:00Z", language: "en" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

describe("checkQuality", () => {
  it("passes a clean minimal walkthrough with no warnings", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ headline: "We move the value", say: "Now the header sees it right away.", check: "The header updates without a reload." })],
      coverage: undefined, // isolate this fixture from the step-count-vs-size check, covered separately below
    });
    expect(checkQuality(w)).toEqual([]);
  });

  it("flags an identifier in plain.title/problem/fix", () => {
    const w = makeWalkthrough({ plain: { title: "Fix `useOutsideClick`", problem: "P", fix: "F" } });
    const codes = checkQuality(w).map((x) => x.code);
    expect(codes).toContain("identifier-in-plain");
  });

  it("flags an identifier (camelCase) in a step headline", () => {
    const w = makeWalkthrough({ steps: [makeStep({ headline: "Fix useOutsideClick behaviour", check: "x" })] });
    const warnings = checkQuality(w);
    expect(warnings.find((x) => x.code === "identifier-in-headline")).toBeTruthy();
  });

  it("flags a file path in a step's say", () => {
    const w = makeWalkthrough({ steps: [makeStep({ say: "See packages/excalidraw/App.tsx for details.", check: "x" })] });
    expect(checkQuality(w).map((x) => x.code)).toContain("identifier-in-say");
  });

  it("flags an identifier in narration and a narration over 4 sentences", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ narration: "The `onClickOutside` handler fires. A. B. C. D.", check: "x" })],
    });
    const codes = checkQuality(w).map((x) => x.code);
    expect(codes).toContain("identifier-in-narration");
    expect(codes).toContain("narration-too-long");
  });

  it("flags narration that mentions how a claim was checked instead of just stating it", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ narration: "The ablation confirms this change alone is sufficient to fix it.", check: "x" })],
    });
    expect(checkQuality(w).map((x) => x.code)).toContain("narration-mentions-process");
  });

  it("does not flag plain narration that states the conclusion directly", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ narration: "This change on its own is enough to fix the overflow.", check: "x" })],
    });
    expect(checkQuality(w).map((x) => x.code)).not.toContain("narration-mentions-process");
  });

  it("flags a headline longer than 9 words", () => {
    const w = makeWalkthrough({ steps: [makeStep({ headline: "one two three four five six seven eight nine ten", check: "x" })] });
    expect(checkQuality(w).map((x) => x.code)).toContain("headline-too-long");
  });

  it("allows a two-sentence say (real writing style)", () => {
    const w = makeWalkthrough({ steps: [makeStep({ say: "First sentence. Second sentence.", check: "x" })] });
    expect(checkQuality(w).map((x) => x.code)).not.toContain("say-too-long");
  });

  it("flags a say field with more than two sentences", () => {
    const w = makeWalkthrough({ steps: [makeStep({ say: "First. Second. Third.", check: "x" })] });
    expect(checkQuality(w).map((x) => x.code)).toContain("say-too-long");
  });

  it("does not ask for a visual on a plain step", () => {
    const w = makeWalkthrough({ steps: [makeStep({ kind: "decision" }), makeStep({ id: "s2", kind: "cause" })], coverage: undefined });
    expect(checkQuality(w)).toEqual([]);
  });

  it("flags a step with traces but no visual", () => {
    const beats = [{ kind: "problem" as const, heading: "h", text: "t", traces: [[{ label: "a" }, { label: "b", status: "bad" as const }]],
      code: [{ file: "a.ts", revision: "base" as const, lines: [{ kind: "focus" as const, text: "x" }] }] }];
    expect(checkQuality(makeWalkthrough({ steps: [makeStep({ kind: "cause", beats })] })).map((x) => x.code)).toContain("traces-without-visual");
    expect(checkQuality(makeWalkthrough({ steps: [makeStep({ kind: "cause", beats, visual: { type: "flow", rows: [] } })] })).map((x) => x.code)).not.toContain("traces-without-visual");
  });

  it("flags a non-symptom step that quotes no code", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ kind: "constraint", visual: { type: "flow", rows: [] }, beats: [{ kind: "problem", heading: "h", text: "t" }] })],
    });
    expect(checkQuality(w).map((x) => x.code)).toContain("step-without-code");
  });

  it("does not require code on a symptom step", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ kind: "symptom", visual: { type: "symptoms", items: ["x"] }, beats: [{ kind: "problem", heading: "h", text: "t" }] })],
    });
    expect(checkQuality(w).map((x) => x.code)).not.toContain("step-without-code");
  });

  it("flags a step that quotes a test file", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ check: "x", beats: [{ kind: "change", heading: "h", text: "t", code: [{ file: "a.test.ts", revision: "head", lines: [] }] }] })],
    });
    expect(checkQuality(w).map((x) => x.code)).toContain("test-file-quoted");
  });

  it("flags too many map visuals", () => {
    const w = makeWalkthrough({
      steps: [
        makeStep({ id: "s1", check: "x", visual: { type: "map" } }),
        makeStep({ id: "s2", check: "x", visual: { type: "map" } }),
        makeStep({ id: "s3", check: "x" }),
      ],
    });
    expect(checkQuality(w).map((x) => x.code)).toContain("too-many-maps");
  });

  it("flags a step count outside the size-based budget", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ id: "s1", check: "x" })], // 1 step
      coverage: { totalHunks: 40, explained: 40, skipped: 0, uncoveredHunkIds: [] }, // budget: 6-10
    });
    expect(checkQuality(w).map((x) => x.code)).toContain("step-count-out-of-budget");
  });

  it("flags meta.analyzer bob-shell with no meta.run attached", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ check: "x" })],
      meta: { analyzer: "bob-shell", generatedAt: "2026-01-01T00:00:00Z", language: "en" },
    });
    expect(checkQuality(w).map((x) => x.code)).toContain("missing-run-meta");
  });

  it("does not warn when meta.run is present", () => {
    const w = makeWalkthrough({
      steps: [makeStep({ check: "x" })],
      meta: {
        analyzer: "bob-shell", generatedAt: "2026-01-01T00:00:00Z", language: "en",
        run: { costUsd: 1, maxCostUsd: 5, durationMs: 1000, toolCalls: 3, subagents: 0, repairs: 0 },
      },
    });
    expect(checkQuality(w).map((x) => x.code)).not.toContain("missing-run-meta");
  });

  // -------------------------------------------------------------------------
  // Sanity check on the real, hand-written Outline example
  // -------------------------------------------------------------------------

  it("produces zero warnings for the Outline golden example", async () => {
    const w = JSON.parse(await readFile(GOLDEN_JSON_PATH, "utf-8")) as Walkthrough;
    // This example is the few-shot reference in the analyzer prompt and the
    // basis the step-count and sentence-count rules above were calibrated
    // against — it should be clean. A regression here means either the
    // example or the checker drifted from docs/output-contract.md.
    expect(checkQuality(w)).toEqual([]);
  });

  it("flags critical codes via criticalQualityWarnings", () => {
    const w = makeWalkthrough({
      steps: [
        makeStep({
          id: "s1",
          say: "Calls `getTotalChangesCount` here.",
          narration: "The ablation confirms this is required.",
        }),
      ],
    });
    const codes = criticalQualityWarnings(checkQuality(w)).map((x) => x.code);
    expect(codes).toContain("identifier-in-say");
    expect(codes).toContain("narration-mentions-process");
  });

  it("treats field-length limits as critical (they were hand-trimmed before)", () => {
    const w = makeWalkthrough({
      steps: [
        makeStep({
          headline: "one two three four five six seven eight nine ten",
          say: "First. Second. Third.",
          narration: "A. B. C. D. E.",
        }),
      ],
      coverage: undefined,
    });
    const codes = criticalQualityWarnings(checkQuality(w)).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["headline-too-long", "say-too-long", "narration-too-long"]));
  });

  it("keeps structural warnings out of the critical set", () => {
    const w = makeWalkthrough({
      steps: [makeStep(), makeStep({ id: "s2" }), makeStep({ id: "s3" }), makeStep({ id: "s4" }), makeStep({ id: "s5" }),
        makeStep({ id: "s6" }), makeStep({ id: "s7" }), makeStep({ id: "s8" }), makeStep({ id: "s9" })],
    });
    const all = checkQuality(w);
    expect(all.map((x) => x.code)).toContain("step-count-out-of-budget");
    expect(criticalQualityWarnings(all).map((x) => x.code)).not.toContain("step-count-out-of-budget");
  });
});

describe("refers-to-screenshot", () => {
  const codes = (w: Walkthrough) => checkQuality(w).map((x) => x.code);

  it("flags prose that points at a picture the reader may not have", () => {
    for (const say of [
      "As you can see in the screenshot, the panel overlaps.",
      "The overlap is shown below.",
      "Look at the picture to compare both states.",
    ]) {
      expect(codes(makeWalkthrough({ steps: [makeStep({ say })], coverage: undefined }))).toContain("refers-to-screenshot");
    }
  });

  it("flags it in narration, headline, plain.* and symptom items", () => {
    const narration = makeWalkthrough({ steps: [makeStep({ narration: "The screenshot makes this obvious." })], coverage: undefined });
    expect(codes(narration)).toContain("refers-to-screenshot");
    const headline = makeWalkthrough({ steps: [makeStep({ headline: "See the screenshot" })], coverage: undefined });
    expect(codes(headline)).toContain("refers-to-screenshot");
    const plain = makeWalkthrough({ plain: { title: "T", problem: "Shown in the screenshot.", fix: "F" }, coverage: undefined });
    expect(codes(plain)).toContain("refers-to-screenshot");
    const symptom = makeWalkthrough({
      steps: [makeStep({ kind: "symptom", visual: { type: "symptoms", items: [{ text: "Overlap, see the screenshot" }] } })],
      coverage: undefined,
    });
    expect(codes(symptom)).toContain("refers-to-screenshot");
  });

  it("does not flag ordinary uses of words like image or shot", () => {
    for (const say of [
      "The Docker image is rebuilt on every push.",
      "The retry is a long shot, so it stays off by default.",
      "Both panels now stay visible on a small screen.",
    ]) {
      expect(codes(makeWalkthrough({ steps: [makeStep({ say })], coverage: undefined }))).not.toContain("refers-to-screenshot");
    }
  });

  it("is a critical code so the one repair pass fixes it", () => {
    const w = makeWalkthrough({ steps: [makeStep({ say: "See the screenshot." })], coverage: undefined });
    expect(criticalQualityWarnings(checkQuality(w)).map((x) => x.code)).toContain("refers-to-screenshot");
  });
});

// ---------------------------------------------------------------------------
// Diagram checks — fixtures are the real diagrams from the first live run of a small PR.
// ---------------------------------------------------------------------------

import { unchangedLayerItems } from "./quality.js";

const LIVE_FLOW: NonNullable<Step["visual"]> = {
  type: "flow",
  rows: [
    [["Click on menu trigger (before)", "old"], ["data-prevent-outside-click", "old"], ["All outside-click listeners skip", "bad"], ["Sidebar stays open", "bad"]],
    [["Click on menu trigger (after)", ""], ["Sidebar outside-click fires", "good"], ["Sidebar closes", "good"], ["Menu opens on top", "good"]],
  ],
};

const LIVE_LAYERS: NonNullable<Step["visual"]> = {
  type: "layers",
  before: [["top bar (mobile / desktop)", 100], ["styles popup", 100], ["context menu", 90], ["sidebar (floating)", 80, "bad"], ["bottom bar", 60]],
  after: [["sidebar (floating)", 120, "hl"], ["top bar (mobile / desktop)", 100], ["styles popup", 100], ["context menu", 90], ["bottom bar", 60]],
};

const codesFor = (visual: Step["visual"]) =>
  checkQuality(makeWalkthrough({ steps: [makeStep({ visual })], coverage: undefined })).map((w) => w.code);

describe("flow diagram checks", () => {
  it("flags the real live diagram: code in a label, marks on more than the last node of a row, too many nodes", () => {
    const codes = codesFor(LIVE_FLOW);
    expect(codes).toContain("visual-label-identifier");
    expect(codes).toContain("flow-too-many-marks");
    expect(codes).toContain("flow-too-big");
  });

  it("passes a small, plain chain with one outcome per side", () => {
    const codes = codesFor({
      type: "flow",
      rows: [[["Tap the menu button", ""], ["The sidebar ignores the tap", "old"], ["Sidebar stays open", "bad"]],
             [["Tap the menu button", ""], ["The sidebar hears the tap", ""], ["Sidebar closes", "good"]]],
    });
    expect(codes.filter((c) => c.startsWith("flow-") || c === "visual-label-identifier")).toEqual([]);
  });

  it("allows a mark only on the last node of a row, and only one", () => {
    const marks = (rows: [string, string][][]) => codesFor({ type: "flow", rows }).includes("flow-too-many-marks");
    expect(marks([[["a", ""], ["b", ""], ["c", "bad"]]])).toBe(false);
    expect(marks([[["a", ""], ["b", "bad"], ["c", ""]]])).toBe(true); // mark in the middle
    expect(marks([[["a", ""], ["b", "bad"], ["c", "bad"]]])).toBe(true); // two marks
    expect(marks([[["a", "old"], ["b", ""], ["c", "bad"]], [["a", ""], ["b", ""], ["c", "good"]]])).toBe(false); // one per row is fine
    expect(marks([[["a", ""], ["b", "old"], ["c", "good"]]])).toBe(false); // "old" is not an outcome mark
  });

  it("flags a label over six words and a row over four nodes separately", () => {
    const longLabel = codesFor({ type: "flow", rows: [[["one two three four five six seven", ""], ["b", "good"]]] });
    expect(longLabel).toContain("flow-too-big");
    const wideRow = codesFor({ type: "flow", rows: [[["a", ""], ["b", ""], ["c", ""], ["d", ""], ["e", "good"]]] });
    expect(wideRow).toContain("flow-too-big");
  });

  it("catches an HTML attribute even when the label cuts it short (seen in a real run: 'data-prevent stops sidebar check')", () => {
    for (const label of ["data-prevent stops sidebar check", "aria-hidden blocks it", "data-testid"]) {
      expect(codesFor({ type: "flow", rows: [[[label, "old"], ["Sidebar stays open", "bad"]]] }), label).toContain("visual-label-identifier");
    }
    expect(codesFor({ type: "flow", rows: [[["The marker stops the sidebar check", "old"], ["Sidebar stays open", "bad"]]] })).not.toContain("visual-label-identifier");
  });

  it("treats kebab-case and CSS variables as code, ordinary hyphens as fine", () => {
    expect(codesFor({ type: "flow", rows: [[["--zIndex-ui-top", ""], ["x", "good"]]] })).toContain("visual-label-identifier");
    expect(codesFor({ type: "flow", rows: [[["A well-known fix", ""], ["Done", "good"]]] })).not.toContain("visual-label-identifier");
  });
});

describe("layers diagram checks", () => {
  it("flags the real live diagram: 5 rows, and the bottom bar that never changes side", () => {
    const codes = codesFor(LIVE_LAYERS);
    expect(codes).toContain("layers-too-many");
    expect(codes).toContain("layers-unchanged-item");
    expect(unchangedLayerItems(LIVE_LAYERS.type === "layers" ? (LIVE_LAYERS.before as never) : [], LIVE_LAYERS.type === "layers" ? (LIVE_LAYERS.after as never) : [])).toEqual(["bottom bar"]);
  });

  it("keeps every item whose order flips, and drops nothing when all of them do", () => {
    const noise = unchangedLayerItems(
      [["top bar", 100], ["context menu", 90], ["sidebar", 80, "bad"]],
      [["sidebar", 120, "hl"], ["top bar", 100], ["context menu", 90]]
    );
    expect(noise).toEqual([]);
  });

  it("allows ONE limit item on the side the value moves toward (the ceiling), not two", () => {
    const one = unchangedLayerItems(
      [["top bar", 100], ["sidebar", 80, "bad"], ["modal", 1000]],
      [["modal", 1000], ["sidebar", 120, "hl"], ["top bar", 100]]
    );
    expect(one).toEqual([]);
    const two = unchangedLayerItems(
      [["top bar", 100], ["sidebar", 80, "bad"], ["modal", 1000], ["toast", 2000]],
      [["toast", 2000], ["modal", 1000], ["sidebar", 120, "hl"], ["top bar", 100]]
    );
    expect(two).toEqual(["toast"]);
  });

  it("mirrors the rule when the value is lowered: the floor is the useful limit, the ceiling is noise", () => {
    const noise = unchangedLayerItems(
      [["header", 500], ["panel", 300, "bad"], ["footer", 10]],
      [["header", 500], ["panel", 50, "hl"], ["footer", 10]]
    );
    expect(noise).toEqual(["header"]);
  });

  it("says nothing when the changed item can't be identified", () => {
    expect(unchangedLayerItems([["a", 1]], [["a", 2]])).toEqual([]);
    expect(codesFor({ type: "layers", before: [["a", 1]], after: [["a", 2]] })).toContain("layers-no-changed-item");
  });

  it("flags a column written lowest-first — the picture would show the loser on top (seen in a real run)", () => {
    const lowestFirst = codesFor({
      type: "layers",
      before: [["sidebar", 80, "bad"], ["top bar", 100]],
      after: [["top bar", 100], ["sidebar", 120, "hl"]],
    });
    expect(lowestFirst).toContain("layers-not-sorted");
    const ok = codesFor({
      type: "layers",
      before: [["top bar", 100], ["sidebar", 80, "bad"]],
      after: [["sidebar", 120, "hl"], ["top bar", 100]],
    });
    expect(ok).not.toContain("layers-not-sorted");
    // equal values keep any order
    expect(codesFor({ type: "layers", before: [["a", 100], ["b", 100], ["c", 50, "bad"]], after: [["c", 150, "hl"], ["a", 100], ["b", 100]] })).not.toContain("layers-not-sorted");
  });

  it("is critical, so the single repair pass fixes diagram problems too", () => {
    const crit = criticalQualityWarnings(checkQuality(makeWalkthrough({ steps: [makeStep({ visual: LIVE_LAYERS })], coverage: undefined }))).map((w) => w.code);
    expect(crit).toEqual(expect.arrayContaining(["layers-too-many", "layers-unchanged-item"]));
  });
});

describe("step-many-hunks", () => {
  const fourFiles = ["a.ts#1", "b.ts#1", "c.ts#1", "d.ts#1"];
  it("warns (softly) when one change step spans four files", () => {
    const found = checkQuality(makeWalkthrough({ steps: [makeStep({ hunkIds: fourFiles })], coverage: undefined }));
    expect(found.map((x) => x.code)).toContain("step-many-hunks");
    expect(criticalQualityWarnings(found).map((x) => x.code)).not.toContain("step-many-hunks");
  });

  it("does not warn for a cohesive implementation: up to three files, or many hunks in one file", () => {
    for (const hunkIds of [["a.ts#1", "b.ts#1", "c.ts#1"], ["a.ts#1", "b.ts#1", "b.ts#2"], ["a.ts#1", "a.ts#2", "a.ts#3", "a.ts#4"]]) {
      expect(checkQuality(makeWalkthrough({ steps: [makeStep({ hunkIds })], coverage: undefined })).map((x) => x.code)).not.toContain("step-many-hunks");
    }
  });

  it("does not warn for minor steps or non-change steps", () => {
    for (const step of [makeStep({ hunkIds: fourFiles, minor: true }), makeStep({ hunkIds: fourFiles, kind: "cause" })]) {
      expect(checkQuality(makeWalkthrough({ steps: [step], coverage: undefined })).map((x) => x.code)).not.toContain("step-many-hunks");
    }
  });
});

describe("symptom-step-visual", () => {
  const codes = (step: Step) => checkQuality(makeWalkthrough({ steps: [step], coverage: undefined })).map((w) => w.code);

  it("flags a symptom step whose visual is a diagram or missing (seen in a real run: layers on the symptom step, no symptoms list)", () => {
    expect(codes(makeStep({ kind: "symptom", visual: { type: "layers", before: [["a", 2, "bad"], ["b", 1]], after: [["a", 3, "hl"], ["b", 1]] } }))).toContain("symptom-step-visual");
    expect(codes(makeStep({ kind: "symptom" }))).toContain("symptom-step-visual");
  });

  it("accepts a symptoms list, and ignores other step kinds and minor symptom steps", () => {
    expect(codes(makeStep({ kind: "symptom", visual: { type: "symptoms", items: [{ text: "Panel hides the menu" }] } }))).not.toContain("symptom-step-visual");
    expect(codes(makeStep({ kind: "cause" }))).not.toContain("symptom-step-visual");
    expect(codes(makeStep({ kind: "symptom", minor: true }))).not.toContain("symptom-step-visual");
  });

  it("is critical so the single repair pass fixes it", () => {
    const found = checkQuality(makeWalkthrough({ steps: [makeStep({ kind: "symptom" })], coverage: undefined }));
    expect(criticalQualityWarnings(found).map((w) => w.code)).toContain("symptom-step-visual");
  });
});
