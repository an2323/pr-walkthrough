import { describe, it, expect } from "vitest";
import type { Ablation, Hunk } from "@pr-walkthrough/shared";

import { ablationHasSignal, runAblation, runKey } from "./ablation.js";
import type { AppRecipe } from "./recipes.js";

const hunk = (id: string): Hunk => ({ id, file: id.split("#")[0], header: "@@", added: 1, removed: 0 });
const recipe = {} as AppRecipe;

describe("runKey", () => {
  it("is the same for the same set of hunks in any order (so a repeated build is measured once)", () => {
    expect(runKey(["b#1", "a#1"])).toBe(runKey(["a#1", "b#1"]));
    expect(runKey(["a#1"])).not.toBe(runKey(["a#1", "b#1"]));
  });

  it("makes 'everything except A' equal to 'B alone' when there are two units", () => {
    const units = ["a#1", "b#1"];
    expect(runKey(units.filter((u) => u !== "a#1"))).toBe(runKey(["b#1"]));
  });
});

describe("runAblation", () => {
  it("has nothing to measure with one logic unit or none — no worktrees, no installs", async () => {
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n x\n+y\n";
    expect(await runAblation({ mainPath: "/nonexistent", baseSha: "x", diff, hunks: [hunk("a.ts#1")], recipe, reproPath: "/none" })).toBeUndefined();
    expect(await runAblation({ mainPath: "/nonexistent", baseSha: "x", diff, hunks: [], recipe, reproPath: "/none" })).toBeUndefined();
  });
});

describe("ablationHasSignal", () => {
  const run = (verdict: "bug" | "fixed" | "broken") => ({ unitIds: ["a"], mode: "alone" as const, verdict });
  it("is false when every run was broken — that table says nothing", () => {
    expect(ablationHasSignal({ units: ["a"], runs: [run("broken"), run("broken")] } as Ablation)).toBe(false);
    expect(ablationHasSignal({ units: ["a"], runs: [] } as Ablation)).toBe(false);
  });
  it("is true as soon as one run gave a real answer", () => {
    expect(ablationHasSignal({ units: ["a"], runs: [run("broken"), run("fixed")] } as Ablation)).toBe(true);
  });
});

import { verdictForStep, summaryVerdict } from "./ablation.js";

describe("verdictForStep with several scenarios (one per user-visible problem)", () => {
  // Two mechanisms: the style hunk fixes scenario "layer", the wrapper hunk fixes scenario "menu".
  const units = ["style#1", "wrapper#1"];
  const r = (unitIds: string[], mode: "alone" | "all-but-one", layer: "bug" | "fixed" | "broken", menu: "bug" | "fixed" | "broken") => ({
    unitIds,
    mode,
    verdict: summaryVerdict([{ verdict: layer }, { verdict: menu }]),
    results: [
      { scenarioId: "layer", verdict: layer },
      { scenarioId: "menu", verdict: menu },
    ],
  });
  const ablation = {
    units,
    scenarios: [{ id: "layer", title: "toolbar drawn over the panel" }, { id: "menu", title: "menu opens with the panel still open" }],
    runs: [
      r(["style#1"], "alone", "fixed", "bug"),
      r(["wrapper#1"], "alone", "bug", "fixed"),
      r(["wrapper#1"], "all-but-one", "bug", "fixed"), // everything except style
      r(["style#1"], "all-but-one", "fixed", "bug"), // everything except wrapper
    ],
  } as unknown as Ablation;

  it("calls each mechanism's hunk needed — never 'no effect' just because the other scenario didn't need it", () => {
    expect(verdictForStep(ablation, ["style#1"])).toBe("needed");
    expect(verdictForStep(ablation, ["wrapper#1"])).toBe("needed");
  });

  it("says no-effect only when the hunk changed nothing in EVERY scenario", () => {
    const three = {
      units: ["a#1", "b#1", "c#1"],
      runs: [
        r(["c#1"], "alone", "bug", "bug"),
        r(["a#1", "b#1"], "all-but-one", "fixed", "fixed"),
      ],
    } as unknown as Ablation;
    expect(verdictForStep(three, ["c#1"])).toBe("no-effect");
  });

  it("keeps old single-scenario ablations working unchanged", () => {
    const old = {
      units: ["a#1", "b#1"],
      runs: [
        { unitIds: ["a#1"], mode: "alone", verdict: "fixed" },
        { unitIds: ["b#1"], mode: "alone", verdict: "bug" },
        { unitIds: ["b#1"], mode: "all-but-one", verdict: "bug" }, // everything except a → bug comes back
        { unitIds: ["a#1"], mode: "all-but-one", verdict: "fixed" }, // everything except b → still fixed
      ],
    } as unknown as Ablation;
    expect(verdictForStep(old, ["a#1"])).toBe("needed");
    expect(verdictForStep(old, ["b#1"])).toBe("no-effect");
  });

  it("summaryVerdict: bug if any scenario still shows its bug, fixed if all answered fixed, else broken", () => {
    expect(summaryVerdict([{ verdict: "fixed" }, { verdict: "bug" }])).toBe("bug");
    expect(summaryVerdict([{ verdict: "fixed" }, { verdict: "broken" }])).toBe("fixed");
    expect(summaryVerdict([{ verdict: "broken" }])).toBe("broken");
  });

  it("has signal when one scenario answered even if the summary is broken", () => {
    expect(ablationHasSignal({ units: ["a"], runs: [{ unitIds: ["a"], mode: "alone", verdict: "broken", results: [{ scenarioId: "x", verdict: "broken" }, { scenarioId: "y", verdict: "fixed" }] }] } as Ablation)).toBe(true);
  });
});
