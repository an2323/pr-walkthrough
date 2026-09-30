import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Walkthrough } from "@pr-walkthrough/shared";

import { checkQuality, criticalQualityWarnings } from "./quality.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const live = (n: number): Walkthrough =>
  JSON.parse(readFileSync(path.join(HERE, `../api/__fixtures__/excalidraw-${n}.live.json`), "utf-8"));
const codes = (wt: Walkthrough) => criticalQualityWarnings(checkQuality(wt)).map((w) => `${w.stepId ?? "-"}:${w.code}`);

describe("thinking aloud and long narration (live #10295 vs the reference)", () => {
  it("catches the self-correction and the over-long step of the live #10295 run", () => {
    const got = codes(live(10295));
    expect(got).toContain("s3:thinking-aloud");
    expect(got).toContain("s6:narration-too-long");
  });

  it("the reference #10295 walkthrough has neither", () => {
    const ref = JSON.parse(readFileSync(path.join(ROOT, "data/walkthroughs/excalidraw/excalidraw/10295.json"), "utf-8")) as Walkthrough;
    expect(codes(ref).filter((c) => /thinking-aloud|narration-too-long/.test(c))).toEqual([]);
  });

  it.each([
    "Users had to wait for the menu to close before drawing.",
    "The panel actually stays open until you click elsewhere.",
    "Let the sidebar's existing close path do the work.",
    "It waits for the next frame, then measures the picker.",
  ])("plain prose is not flagged: %s", (narration) => {
    const wt = live(10943);
    wt.steps[0].narration = narration;
    expect(codes(wt).filter((c) => c.endsWith("thinking-aloud"))).toEqual([]);
  });

  it.each([
    "The new value sits below the context menu — wait, actually above both.",
    "It is 80. Hmm, it is 120 after the fix.",
    "The trigger is removed, I mean the attribute on it is removed.",
    "Actually, no: the menu closes first.",
  ])("a self-correction is flagged: %s", (narration) => {
    const wt = live(10943);
    wt.steps[0].narration = narration;
    expect(codes(wt)).toContain(`${wt.steps[0].id}:thinking-aloud`);
  });
});
