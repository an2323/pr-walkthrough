import { describe, it, expect } from "vitest";
import type { Ablation } from "@pr-walkthrough/shared";
import { logicUnits, verdictForStep } from "./ablation.js";

describe("logicUnits", () => {
  it("excludes skipped (mechanical) hunks", () => {
    const hunks = [
      { id: "a.ts#1", file: "a.ts", header: "", added: 1, removed: 0 },
      { id: "a.ts#2", file: "a.ts", header: "", added: 1, removed: 0 },
      { id: "b.ts#1", file: "b.ts", header: "", added: 1, removed: 0 },
    ];
    const units = logicUnits(hunks, [{ hunkId: "a.ts#2", reason: "unused import" }]);
    expect(units).toEqual(["a.ts#1", "b.ts#1"]);
  });
});

// Mirrors #10943's real table: 3 units, scss#1 is the fix, tsx#2 is only needed
// on narrow screens (here: needed), tsx#3 fixes nothing alone but isn't needed either.
const ABLATION: Ablation = {
  units: ["scss#1", "tsx#2", "tsx#3"],
  runs: [
    { unitIds: ["scss#1"], mode: "alone", verdict: "bug" },
    { unitIds: ["tsx#2"], mode: "alone", verdict: "bug" },
    { unitIds: ["tsx#3"], mode: "alone", verdict: "fixed" },
    { unitIds: ["tsx#2", "tsx#3"], mode: "all-but-one", verdict: "fixed" }, // without scss#1: still fixed
    { unitIds: ["scss#1", "tsx#3"], mode: "all-but-one", verdict: "bug" }, // without tsx#2: bug returns
    { unitIds: ["scss#1", "tsx#2"], mode: "all-but-one", verdict: "fixed" }, // without tsx#3: still fixed
  ],
};

describe("verdictForStep", () => {
  it("marks a unit as needed when removing it alone brings the bug back", () => {
    expect(verdictForStep(ABLATION, ["tsx#2"])).toBe("needed");
  });

  it("marks a unit as fixes-alone when it alone is sufficient and not required", () => {
    expect(verdictForStep(ABLATION, ["tsx#3"])).toBe("fixes-alone");
  });

  it("marks a unit as no-effect when neither alone nor its absence changes the outcome", () => {
    expect(verdictForStep(ABLATION, ["scss#1"])).toBe("no-effect");
  });

  it("returns not-separable when a step's hunks don't map to exactly one unit", () => {
    expect(verdictForStep(ABLATION, ["tsx#2", "tsx#3"])).toBe("not-separable");
    expect(verdictForStep(ABLATION, ["unknown-hunk"])).toBe("not-separable");
  });
});
