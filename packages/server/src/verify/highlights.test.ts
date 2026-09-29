import { describe, it, expect } from "vitest";
import { cleanHighlight, normalizeHighlights, maybeCropRegion, tidyLabel, focusOnChange } from "./highlights.js";

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

describe("maybeCropRegion", () => {
  it("returns a padded crop when the marked area is a small fraction of the image", () => {
    const hl = [{ x: 0.05, y: 0.63, w: 0.14, h: 0.09 }];
    const crop = maybeCropRegion(hl, hl);
    expect(crop).toBeDefined();
    expect(crop!.w).toBeGreaterThan(0.14);
    expect(crop!.h).toBeGreaterThan(0.09);
    expect(crop!.x).toBeLessThanOrEqual(0.05);
    expect(crop!.x + crop!.w).toBeGreaterThanOrEqual(0.05 + 0.14);
  });

  it("returns undefined when the marked area is already a meaningful fraction of the image", () => {
    const hl = [{ x: 0.1, y: 0.1, w: 0.6, h: 0.6 }];
    expect(maybeCropRegion(hl, hl)).toBeUndefined();
  });

  it("returns undefined with no highlights on either side", () => {
    expect(maybeCropRegion([], [])).toBeUndefined();
  });

  it("clamps the padded crop to the image bounds", () => {
    const hl = [{ x: 0.0, y: 0.0, w: 0.05, h: 0.05 }];
    const crop = maybeCropRegion(hl, []);
    expect(crop!.x).toBe(0);
    expect(crop!.y).toBe(0);
    expect(crop!.x + crop!.w).toBeLessThanOrEqual(1);
  });
});

describe("tidyLabel — Bob writes sentences; a label is a short caption", () => {
  it("drops parentheticals and cuts at a word boundary, not mid-word (real labels from a live run)", () => {
    expect(tidyLabel("Sidebar z-index (80) < toolbar (100): toolbar buttons appear ON TOP of sidebar")).toBe("Sidebar z-index < toolbar");
    expect(tidyLabel("Sidebar still visible under main menu (should be closed)")).toBe("Sidebar still visible under main menu");
  });

  it("never ends on a dangling connective or punctuation", () => {
    expect(tidyLabel("Menu opened, and the")).toBe("Menu opened");
    expect(tidyLabel("Sidebar closed by itself:")).toBe("Sidebar closed by itself");
  });

  it("leaves a good short label alone and keeps hard-cut words whole", () => {
    expect(tidyLabel("Sidebar is still open")).toBe("Sidebar is still open");
    expect(tidyLabel("Supercalifragilisticexpialidocious-and-more-and-more-and-more")).toHaveLength(40);
  });

  it("cleanHighlight uses it", () => {
    expect(cleanHighlight({ x: 0.1, y: 0.1, w: 0.3, h: 0.3, label: "Menu is open here (dropdown)" })?.label).toBe("Menu is open here");
  });
});

describe("focusOnChange — point at what changed, not at the whole component", () => {
  const region = { x: 0.7, y: 0.02, w: 0.2, h: 0.06 };

  it("replaces a box covering most of the picture with the changed region, keeping label and pair", () => {
    const out = focusOnChange([{ x: 0.25, y: 0, w: 0.75, h: 0.98, label: "Sidebar behind toolbar", pair: "s" }], region);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Sidebar behind toolbar");
    expect(out[0].pair).toBe("s");
    expect(out[0].w).toBeLessThan(0.35);
    expect(out[0].h).toBeLessThan(0.15);
    expect(out[0].x).toBeLessThan(0.7); // padded
  });

  it("leaves small, specific boxes from the model alone", () => {
    const hl = [{ x: 0.7, y: 0.02, w: 0.1, h: 0.05, label: "Close button" }];
    expect(focusOnChange(hl, region)).toEqual(hl);
  });

  it("gives an unlabeled box when the model marked nothing", () => {
    const out = focusOnChange([], region);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBeUndefined();
  });

  it("does nothing without a region, or when the change is most of the page anyway", () => {
    const hl = [{ x: 0, y: 0, w: 1, h: 1, label: "Everything" }];
    expect(focusOnChange(hl, null)).toEqual(hl);
    expect(focusOnChange(hl, { x: 0.05, y: 0.05, w: 0.9, h: 0.9 })).toEqual(hl);
  });
});
