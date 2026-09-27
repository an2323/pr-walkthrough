/**
 * revise.test.ts — contradiction detection + stitch fix (no Bob).
 */

import { describe, it, expect } from "vitest";
import type { Ablation, Walkthrough, Step } from "@pr-walkthrough/shared";
import { ablationContradictsWalkthrough, tryMechanicalStitchFix } from "./revise.js";

const ABLATION: Ablation = {
  units: ["scss#1", "tsx#2", "tsx#3"],
  runs: [
    { unitIds: ["scss#1"], mode: "alone", verdict: "bug" },
    { unitIds: ["tsx#2"], mode: "alone", verdict: "bug" },
    { unitIds: ["tsx#3"], mode: "alone", verdict: "fixed" },
    { unitIds: ["tsx#2", "tsx#3"], mode: "all-but-one", verdict: "fixed" },
    { unitIds: ["scss#1", "tsx#3"], mode: "all-but-one", verdict: "bug" },
    { unitIds: ["scss#1", "tsx#2"], mode: "all-but-one", verdict: "fixed" },
  ],
};

function step(overrides: Partial<Step> & Pick<Step, "id" | "hunkIds">): Step {
  return {
    kind: "change",
    routeLabel: "Change",
    title: "A change",
    focusNode: "n1",
    tag: "fact",
    narration: "Something changed.",
    beats: [],
    sources: [],
    ...overrides,
  };
}

function wt(steps: Step[]): Walkthrough {
  return {
    schemaVersion: 1,
    pr: {
      repo: "o/r",
      number: 1,
      title: "t",
      url: "u",
      author: "a",
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      commitTitles: [],
    },
    summary: { problem: "p", solution: "f" },
    plain: { title: "t", problem: "p", fix: "f" },
    graph: { nodes: [], edges: [] },
    steps,
    openQuestions: [],
    skippedHunks: [],
    hunks: [],
    coverage: { totalHunks: 0, explained: 0, skipped: 0, uncoveredHunkIds: [] },
    meta: { analyzer: "bob-shell", generatedAt: "", durationMs: 0, language: "en" },
  };
}

describe("ablationContradictsWalkthrough", () => {
  it("flags a needed unit marked minor", () => {
    expect(
      ablationContradictsWalkthrough(
        wt([step({ id: "s1", hunkIds: ["tsx#2"], minor: true, headline: "Tiny tweak" })]),
        ABLATION
      )
    ).toBe(true);
  });

  it("flags a non-minor no-effect change step", () => {
    expect(
      ablationContradictsWalkthrough(
        wt([
          step({
            id: "s5",
            hunkIds: ["scss#1"],
            kind: "change",
            headline: "Collapse the picker",
            say: "This CSS change fixes the overflow.",
          }),
        ]),
        ABLATION
      )
    ).toBe(true);
  });

  it("does not flag a consistent fixes-alone step", () => {
    expect(
      ablationContradictsWalkthrough(
        wt([
          step({
            id: "s4",
            hunkIds: ["tsx#3"],
            headline: "Position the picker",
            say: "This alone is enough for the measured bug.",
          }),
        ]),
        ABLATION
      )
    ).toBe(false);
  });

  it("does not flag not-separable steps alone", () => {
    expect(
      ablationContradictsWalkthrough(
        wt([step({ id: "s1", hunkIds: ["tsx#2", "tsx#3"], headline: "Two changes together" })]),
        ABLATION
      )
    ).toBe(false);
  });
});

describe("tryMechanicalStitchFix", () => {
  it("inserts an elided line at the reported index", () => {
    const draft = {
      steps: [
        {
          id: "s6",
          beats: [
            {
              code: [
                {
                  lines: [
                    { kind: "context", text: "a" },
                    { kind: "context", text: "b" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const ok = tryMechanicalStitchFix(draft, [
      "step s6 beat 0 block 0 line 1: quoted lines are not adjacent",
    ]);
    expect(ok).toBe(true);
    expect(draft.steps[0].beats[0].code[0].lines).toEqual([
      { kind: "context", text: "a" },
      { kind: "elided", text: "…" },
      { kind: "context", text: "b" },
    ]);
  });
});
