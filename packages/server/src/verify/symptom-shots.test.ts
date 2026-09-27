import { describe, it, expect } from "vitest";
import type { Walkthrough } from "@pr-walkthrough/shared";
import {
  attachSymptomShots,
  findSymptomsStep,
  listSymptomTexts,
  parseSymptomsManifest,
  symptomItemText,
} from "./symptom-shots.js";

function minimalWt(items: Walkthrough["steps"][number]["visual"]): Walkthrough {
  const baseStep = {
    tag: "fact" as const,
    narration: "n",
    focusNode: "n1",
    beats: [] as [],
    hunkIds: [] as string[],
    sources: [] as [],
  };
  return {
    schemaVersion: 1,
    pr: {
      repo: "excalidraw/excalidraw",
      number: 10295,
      title: "t",
      url: "https://github.com/excalidraw/excalidraw/pull/10295",
      author: "a",
      filesChanged: 1,
      additions: 1,
      deletions: 1,
      commitTitles: [],
    },
    summary: { problem: "p", solution: "s" },
    hunks: [],
    graph: { nodes: [], edges: [] },
    steps: [
      {
        id: "s1",
        kind: "symptom",
        routeLabel: "Symptoms",
        title: "Symptoms",
        ...baseStep,
        visual: items,
      },
      {
        id: "s2",
        kind: "change",
        routeLabel: "Change",
        title: "Change",
        ...baseStep,
        minor: true,
        visual: { type: "symptoms", items: ["ignored minor"] },
      },
    ],
    skippedHunks: [],
    openQuestions: [],
    coverage: { totalHunks: 0, explained: 0, skipped: 0, uncoveredHunkIds: [] },
    meta: { analyzer: "manual", generatedAt: "2026-01-01T00:00:00Z", language: "en" },
  };
}

describe("parseSymptomsManifest", () => {
  it("parses skip and file entries", () => {
    const m = parseSymptomsManifest({
      items: [
        { index: 0, skip: "not visible in a still" },
        { index: 1, file: "symptom-1.cjs", src: "symptom-1.png" },
        { index: "x", file: "bad.cjs" },
        { index: 2, file: "../evil.cjs" },
      ],
    });
    expect(m).toEqual({
      items: [
        { index: 0, skip: "not visible in a still" },
        { index: 1, file: "symptom-1.cjs", src: "symptom-1.png" },
        { index: 2, file: "evil.cjs" },
      ],
    });
  });

  it("accepts a bare array (Bob's common shape)", () => {
    expect(
      parseSymptomsManifest([
        { index: 0, skip: "not visible" },
        { index: 1, file: "symptom-1.cjs" },
      ])
    ).toEqual({
      items: [
        { index: 0, skip: "not visible" },
        { index: 1, file: "symptom-1.cjs" },
      ],
    });
  });

  it("returns null for empty or malformed input", () => {
    expect(parseSymptomsManifest(null)).toBeNull();
    expect(parseSymptomsManifest({})).toBeNull();
    expect(parseSymptomsManifest({ items: [{ index: 0 }] })).toBeNull();
  });

  it("rejects non-.cjs files", () => {
    expect(parseSymptomsManifest({ items: [{ index: 0, file: "symptom-0.js" }] })).toBeNull();
  });
});

describe("listSymptomTexts / findSymptomsStep", () => {
  it("reads texts from the first non-minor symptoms step", () => {
    const wt = minimalWt({
      type: "symptoms",
      items: ["Toolbar over sidebar", { text: "Menu under sidebar", src: "old.png" }],
    });
    expect(findSymptomsStep(wt)?.id).toBe("s1");
    expect(listSymptomTexts(wt)).toEqual(["Toolbar over sidebar", "Menu under sidebar"]);
    expect(symptomItemText("plain")).toBe("plain");
  });

  it("returns empty when there is no symptoms visual", () => {
    const wt = minimalWt({ type: "flow", rows: [[["a", ""]]] });
    expect(listSymptomTexts(wt)).toEqual([]);
  });
});

describe("attachSymptomShots", () => {
  it("attaches src by index and normalizes string items", () => {
    const wt = minimalWt({
      type: "symptoms",
      items: ["Toolbar over sidebar", { text: "Menu under sidebar" }],
    });
    attachSymptomShots(wt, new Map([[1, "symptom-1-annotated.png"]]));
    const items = findSymptomsStep(wt)!.visual!;
    expect(items).toEqual({
      type: "symptoms",
      items: [
        "Toolbar over sidebar",
        { text: "Menu under sidebar", src: "symptom-1-annotated.png" },
      ],
    });
  });

  it("accepts a plain record and overwrites an existing src", () => {
    const wt = minimalWt({
      type: "symptoms",
      items: [{ text: "A", src: "old.png" }, { text: "B" }],
    });
    attachSymptomShots(wt, { 0: "symptom-0.png" });
    expect(findSymptomsStep(wt)!.visual).toEqual({
      type: "symptoms",
      items: [{ text: "A", src: "symptom-0.png" }, { text: "B" }],
    });
  });

  it("is a no-op when there is no symptoms step", () => {
    const wt = minimalWt({ type: "layers", before: [["x", 1]], after: [["x", 2]] });
    const before = JSON.stringify(wt.steps);
    attachSymptomShots(wt, { 0: "x.png" });
    expect(JSON.stringify(wt.steps)).toBe(before);
  });
});
