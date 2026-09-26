/**
 * quality.test.ts — unit tests for the soft output-contract checks, plus a
 * sanity run against the real Outline golden JSON (docs/output-contract.md).
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Walkthrough, Step } from "@pr-walkthrough/shared";
import { checkQuality } from "./quality.js";

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
});
