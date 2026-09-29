import { describe, expect, it } from "vitest";

import { busyness, buildAnnotationHtml, pillSize, placePills } from "./annotate.js";
import type { Decoded } from "./png-diff.js";

const AREA = { x: 0, y: 0, w: 1280, h: 800 };
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A white frame with a dark, busy block (stripes) where the app has content. */
function frame(busy: { x: number; y: number; w: number; h: number }[]): Decoded {
  const width = 1280, height = 800, channels = 3;
  const data = Buffer.alloc(width * height * channels, 255);
  for (const b of busy)
    for (let y = b.y; y < b.y + b.h; y++)
      for (let x = b.x; x < b.x + b.w; x++) {
        const v = (x + y) % 8 < 4 ? 20 : 235;
        const i = (y * width + x) * channels;
        data[i] = data[i + 1] = data[i + 2] = v;
      }
  return { width, height, channels, data };
}

describe("placePills", () => {
  const menu = { x: 15, y: 63, w: 236, h: 657 };
  const sidebar = { x: 986, y: 0, w: 294, h: 800 };

  it("keeps every pill inside the frame and off the other pills", () => {
    const spots = placePills([{ box: menu, label: "Main menu opened" }, { box: sidebar, label: "Sidebar is still open" }], AREA, 19);
    for (const s of spots) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w).toBeLessThanOrEqual(1280);
      expect(s.y + s.h).toBeLessThanOrEqual(800);
    }
    expect(overlaps(spots[0], spots[1])).toBe(false);
  });

  it("puts a pill beside its box, not on busy content", () => {
    // The app content fills the right of the menu except a free band lower down.
    const px = frame([{ x: 260, y: 60, w: 700, h: 500 }]);
    const [s] = placePills([{ box: menu, label: "Main menu opened" }], AREA, 19, px);
    expect(busyness(px, s)).toBeLessThan(0.05);
  });

  it("falls back inside the crop instead of dropping the label", () => {
    const tiny = { x: 100, y: 100, w: 300, h: 120 };
    const [s] = placePills([{ box: { x: 110, y: 110, w: 280, h: 100 }, label: "A quite long label here" }], tiny, 19);
    expect(s.x).toBeGreaterThanOrEqual(tiny.x);
    expect(s.w).toBe(pillSize("A quite long label here", 19).w);
  });
});

describe("buildAnnotationHtml", () => {
  it("draws a gone element dashed and every label as a pill, no legend or numbers", () => {
    const html = buildAnnotationHtml("AAAA", { width: 1280, height: 800 }, [
      { x: 0.01, y: 0.08, w: 0.18, h: 0.82, label: "Main menu opened" },
      { x: 0.77, y: 0, w: 0.23, h: 1, label: "Sidebar closed by itself", gone: true },
    ], "good");
    expect(html).toContain("border-style:dashed");
    expect(html.match(/class="pill"/g)).toHaveLength(2);
    expect(html).not.toContain("legend");
    expect(html).not.toContain("badge");
  });
});
