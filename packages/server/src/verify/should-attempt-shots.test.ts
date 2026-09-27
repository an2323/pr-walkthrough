/**
 * should-attempt-shots.test.ts
 */

import { describe, it, expect } from "vitest";
import type { Walkthrough } from "@pr-walkthrough/shared";
import { shouldAttemptShots } from "./should-attempt-shots.js";

function wt(title: string, files: string[]): Walkthrough {
  return {
    schemaVersion: 1,
    pr: {
      repo: "excalidraw/excalidraw",
      number: 1,
      title,
      url: "u",
      author: "a",
      filesChanged: files.length,
      additions: 1,
      deletions: 0,
      commitTitles: [],
    },
    summary: { problem: "p", solution: "f" },
    plain: { title, problem: "p", fix: "f" },
    graph: { nodes: [], edges: [] },
    steps: [],
    openQuestions: [],
    skippedHunks: [],
    hunks: files.map((file, i) => ({
      id: `${file}#${i + 1}`,
      file,
      header: "",
      added: 1,
      removed: 0,
    })),
    coverage: { totalHunks: files.length, explained: 0, skipped: 0, uncoveredHunkIds: [] },
    meta: { analyzer: "bob-shell", generatedAt: "", durationMs: 0, language: "en" },
  };
}

describe("shouldAttemptShots", () => {
  it("skips a perf PR with no UI files (#8340-class)", () => {
    const d = shouldAttemptShots(
      wt("perf: improve new element drawing", [
        "packages/excalidraw/renderer/renderNewElementScene.ts",
        "packages/excalidraw/scene/export.ts",
      ])
    );
    expect(d.attempt).toBe(false);
  });

  it("attempts a UI bugfix", () => {
    const d = shouldAttemptShots(
      wt("fix(editor): arrowhead picker overflowing viewport", [
        "packages/excalidraw/components/IconPicker.tsx",
        "packages/excalidraw/components/IconPicker.scss",
      ])
    );
    expect(d.attempt).toBe(true);
  });

  it("still attempts perf that touches scss/tsx (unsure → attempt)", () => {
    const d = shouldAttemptShots(
      wt("perf: faster sidebar paint", ["packages/excalidraw/components/Sidebar.tsx"])
    );
    expect(d.attempt).toBe(true);
  });
});
