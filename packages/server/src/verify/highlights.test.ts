import { describe, it, expect } from "vitest";
import { cleanHighlight, normalizeHighlights } from "./highlights.js";

describe("cleanHighlight", () => {
  it("clamps a box that runs off the image", () => {
    expect(cleanHighlight({ x: 0.9, y: -0.1, w: 0.5, h: 0.3, label: "  Sidebar  " })).toEqual({
      x: 0.9,
      y: 0,
      w: expect.closeTo(0.1, 5),
      h: 0.3,
      label: "Sidebar",
    });
  });

  it("drops malformed and degenerate boxes", () => {
    expect(cleanHighlight({ x: "a", y: 0, w: 1, h: 1 })).toBeUndefined();
    expect(cleanHighlight({ x: 0, y: 0, w: 0, h: 0 })).toBeUndefined();
    expect(cleanHighlight(null)).toBeUndefined();
  });
});

describe("normalizeHighlights", () => {
  it("gives paired boxes the same union rectangle on both sides", () => {
    const { before, after } = normalizeHighlights(
      [{ x: 0.77, y: 0, w: 0.23, h: 1, label: "Sidebar stays open", pair: "sidebar" }],
      [{ x: 0.75, y: 0, w: 0.25, h: 0.8, label: "Sidebar closes", pair: "sidebar" }]
    );
    expect(before[0]).toMatchObject({ x: 0.75, y: 0, h: 1, label: "Sidebar stays open" });
    expect(before[0].w).toBeCloseTo(0.25, 5);
    expect(after[0]).toMatchObject({ x: 0.75, y: 0, h: 1, label: "Sidebar closes" });
    expect(after[0].w).toBeCloseTo(0.25, 5);
  });

  it("leaves unpaired boxes alone and caps the count per side", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ x: i * 0.1, y: 0, w: 0.05, h: 0.05 }));
    const { before, after } = normalizeHighlights(many, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, pair: "x" }]);
    expect(before).toHaveLength(3);
    expect(after[0]).toMatchObject({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });
});
