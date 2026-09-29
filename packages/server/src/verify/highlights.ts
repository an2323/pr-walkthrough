/**
 * highlights.ts — clean up the highlight boxes the verifier returns before
 * they are drawn into the screenshots: clamp to the image, drop junk, cap the
 * count, and give paired boxes (same `pair` id on Before and After) one shared
 * rectangle — the union of the two — so the eye compares the same spot.
 */

import type { ShotHighlight } from "@pr-walkthrough/shared";

const MAX_PER_SIDE = 3;
const MAX_LABEL = 40;
const TRAILING_WORDS = /\s+(?:to|the|a|an|of|in|on|at|and|or|is|are|as|but|with|for|by|that|than)$/i;

/**
 * Bob's labels are often sentences with property names and numbers ("Sidebar z-index (80) <
 * toolbar (100): toolbar buttons appear on top"), and cutting those at N characters left
 * fragments like "…(100): to". A label is a two-to-five word caption: drop parentheticals, cut at
 * a word boundary, and never end on a dangling connective or punctuation.
 */
export function tidyLabel(raw: string, max = MAX_LABEL): string {
  let t = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  // "Caption: explanation" — the caption is what fits on a picture.
  const head = t.split(/\s*[:—–]\s+|\s+-\s+/)[0];
  if (head.length >= 8) t = head;
  if (t.length > max) {
    const cut = t.slice(0, max);
    const at = cut.lastIndexOf(" ");
    t = at > 12 ? cut.slice(0, at) : cut;
  }
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/[\s:;,.\-–—<>=/]+$/, "").replace(TRAILING_WORDS, "");
  }
  return t;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Clamp one box to [0,1]; returns undefined for a malformed or degenerate box. */
export function cleanHighlight(raw: unknown): ShotHighlight | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const nums = [o.x, o.y, o.w, o.h].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  const x = clamp01(nums[0]);
  const y = clamp01(nums[1]);
  const w = clamp01(Math.min(nums[2], 1 - x));
  const h = clamp01(Math.min(nums[3], 1 - y));
  if (w < 0.005 || h < 0.005) return undefined;
  const hl: ShotHighlight = { x, y, w, h };
  if (typeof o.label === "string" && o.label.trim()) {
    const label = tidyLabel(o.label);
    if (label) hl.label = label;
  }
  if (typeof o.pair === "string" && o.pair.trim()) hl.pair = o.pair.trim();
  return hl;
}

function union(a: ShotHighlight, b: ShotHighlight): Pick<ShotHighlight, "x" | "y" | "w" | "h"> {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * Clean both sides and apply pairing. A `pair` id present on only one side is
 * kept as an ordinary box.
 */
export function normalizeHighlights(
  beforeRaw: unknown[],
  afterRaw: unknown[]
): { before: ShotHighlight[]; after: ShotHighlight[] } {
  const before = beforeRaw.map(cleanHighlight).filter((h): h is ShotHighlight => !!h).slice(0, MAX_PER_SIDE);
  const after = afterRaw.map(cleanHighlight).filter((h): h is ShotHighlight => !!h).slice(0, MAX_PER_SIDE);
  for (const b of before) {
    if (!b.pair) continue;
    const a = after.find((h) => h.pair === b.pair);
    if (!a) continue;
    const rect = union(b, a);
    Object.assign(b, rect);
    Object.assign(a, rect);
  }
  return { before, after };
}

export interface CropRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CROP_AREA_THRESHOLD = 0.25; // only crop when the marked area is well under this fraction of the image
// Extra context around the union box, as a fraction of the box's own size. Generous on
// purpose: a label drawn below/beside a box (annotate.ts) needs room too, and a crop
// that clips the label it was meant to make readable defeats the point (seen on #10943
// at a tighter padding — the label ran off the crop's own edge).
const CROP_PADDING = 1.3;

/**
 * When the marked area is a small fraction of a large screenshot — a real risk
 * on a desktop-resolution capture where the change itself is a small element
 * (confirmed on #10943: a 1280×800 shot where the picker's box covers ~1% of
 * the image and the actual pixel shift is a few px, invisible at normal
 * viewing size) — return one padded crop rectangle for BOTH sides to share, so
 * before/after zoom into the same window instead of the reader hunting for a
 * tiny box on a full desktop screenshot. Returns undefined when the marked
 * area is already a meaningful fraction of the image (cropping would remove
 * context without adding legibility).
 */
export function maybeCropRegion(before: ShotHighlight[], after: ShotHighlight[]): CropRegion | undefined {
  const all = [...before, ...after];
  if (all.length === 0) return undefined;
  const x0 = Math.min(...all.map((h) => h.x));
  const y0 = Math.min(...all.map((h) => h.y));
  const x1 = Math.max(...all.map((h) => h.x + h.w));
  const y1 = Math.max(...all.map((h) => h.y + h.h));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w * h > CROP_AREA_THRESHOLD) return undefined;
  const padX = w * CROP_PADDING;
  const padY = h * CROP_PADDING;
  // A label usually sits just below its box (annotate.ts's labelStyle) and can run to a
  // few lines — a flat extra allowance (independent of the box's own, possibly tiny,
  // height) so the crop doesn't clip the very thing it exists to make readable.
  const LABEL_ROOM = 0.18;
  const x = Math.max(0, x0 - padX);
  const y = Math.max(0, y0 - padY);
  return { x, y, w: Math.min(1, x1 + padX) - x, h: Math.min(1, y1 + padY + LABEL_ROOM) - y };
}

/** Area of a box as a fraction of the image. */
const area = (h: { w: number; h: number }) => h.w * h.h;

/**
 * Re-aim highlights at what actually changed. A model tends to box the whole component ("the sidebar")
 * while the visible difference is a few controls inside it; a box around everything shows the reader
 * nothing. Any highlight covering more than half the image is replaced by the changed region (padded
 * so the surroundings stay readable), keeping its label and pair; a side left with no highlight gets
 * an unlabeled box on the region. Small, specific boxes from the model are left alone.
 */
export function focusOnChange(
  hl: ShotHighlight[],
  region: { x: number; y: number; w: number; h: number } | null,
  opts: { pad?: number; bigArea?: number } = {}
): ShotHighlight[] {
  if (!region) return hl;
  const pad = opts.pad ?? 0.03;
  const x = clamp01(region.x - pad);
  const y = clamp01(region.y - pad);
  const box = { x, y, w: clamp01(Math.min(region.w + 2 * pad, 1 - x)), h: clamp01(Math.min(region.h + 2 * pad, 1 - y)) };
  // The changed region is itself most of the image (a whole-page change): nothing sharper to point at.
  if (area(box) > 0.5) return hl;
  const big = opts.bigArea ?? 0.5;
  if (hl.length === 0) return [{ ...box }];
  const out = hl.map((h) => (area(h) > big ? { ...h, ...box } : h));
  return out;
}
