/**
 * annotate-render.test.ts — the look of the frames, held to measurable rules on REAL captures
 * (a 1280×800 desktop frame, a 768×1024 tablet frame, a 390×844 phone frame). Not "does it look
 * right today" — invariants that must hold for whatever a script returns, so a future PR can't
 * quietly bring back a squashed, over-cropped or label-covered frame.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { ShotHighlight } from "@pr-walkthrough/shared";

import { annotateShot, busyness, placePills } from "./annotate.js";
import { isPhoneFrame, pngDimensions } from "./frames.js";
import { decodePng } from "./png-diff.js";
import { maybeCropRegion } from "../verify/highlights.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => path.join(HERE, "__fixtures__", n);
const out = mkdtempSync(path.join(os.tmpdir(), "annotate-render-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

// Whole-element boxes, the way a script following the prompt returns them.
const DESKTOP: ShotHighlight[] = [
  { x: 15 / 1280, y: 63 / 800, w: 236 / 1280, h: 657 / 800, label: "Main menu opened" },
  { x: 986 / 1280, y: 0, w: 294 / 1280, h: 1, label: "Sidebar is still open" },
];
const TABLET: ShotHighlight[] = [{ x: 0.044, y: 0.683, w: 0.246, h: 0.039, label: "Canvas background color picker" }];

const px = (n: string) => decodePng(readFileSync(fx(n)))!;

describe("the fixtures are the kinds of frame the rules talk about", () => {
  it("classifies them", () => {
    expect(isPhoneFrame(readFileSync(fx("phone-before.png")))).toBe(true);
    expect(isPhoneFrame(readFileSync(fx("tablet-before.png")))).toBe(false);
    expect(isPhoneFrame(readFileSync(fx("desktop-before.png")))).toBe(false);
  });
});

describe("label placement on real frames", () => {
  for (const [name, frame, hl] of [
    ["desktop", "desktop-before.png", DESKTOP],
    ["tablet", "tablet-before.png", TABLET],
  ] as const) {
    it(`${name}: every pill is inside the frame, on blank space, off the other pills`, () => {
      const p = px(frame);
      const area = { x: 0, y: 0, w: p.width, h: p.height };
      const items = hl.map((h) => ({ box: { x: h.x * p.width, y: h.y * p.height, w: h.w * p.width, h: h.h * p.height }, label: h.label! }));
      const spots = placePills(items, area, 19, p);
      spots.forEach((s, i) => {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.x + s.w).toBeLessThanOrEqual(p.width);
        expect(s.y + s.h).toBeLessThanOrEqual(p.height);
        expect(busyness(p, s), `pill ${i} covers content`).toBeLessThan(0.12);
        spots.slice(i + 1).forEach((o) => expect(s.x < o.x + o.w && o.x < s.x + s.w && s.y < o.y + o.h && o.y < s.y + s.h).toBe(false));
      });
    });
  }
});

describe("rendered output (real Chromium)", () => {
  it("a crop keeps the frame's proportions (no stretching) and is large enough to read", async () => {
    const crop = maybeCropRegion(TABLET, [])!;
    const dim = pngDimensions(readFileSync(fx("tablet-before.png")))!;
    const o = path.join(out, "tablet.png");
    await annotateShot(fx("tablet-before.png"), o, TABLET, "bad", crop);
    const got = pngDimensions(readFileSync(o))!;
    const want = (crop.w * dim.width) / (crop.h * dim.height);
    expect(got.width / got.height).toBeCloseTo(want, 1);
    expect(got.width).toBeGreaterThanOrEqual(500);
    // never a tight strip: at least 60% × 45% of the source frame is shown
    expect(crop.w * dim.width).toBeGreaterThanOrEqual(0.6 * dim.width - 1);
    expect(crop.h * dim.height).toBeGreaterThanOrEqual(0.45 * dim.height - 1);
  }, 60_000);

  it("an uncropped desktop frame keeps its exact size", async () => {
    const o = path.join(out, "desktop.png");
    await annotateShot(fx("desktop-before.png"), o, DESKTOP, "bad");
    expect(pngDimensions(readFileSync(o))).toEqual({ width: 1280, height: 800 });
  }, 60_000);
});
