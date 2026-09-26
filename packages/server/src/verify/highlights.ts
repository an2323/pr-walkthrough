/**
 * highlights.ts — clean up the highlight boxes the verifier returns before
 * they are drawn into the screenshots: clamp to the image, drop junk, cap the
 * count, and give paired boxes (same `pair` id on Before and After) one shared
 * rectangle — the union of the two — so the eye compares the same spot.
 */

import type { ShotHighlight } from "@pr-walkthrough/shared";

const MAX_PER_SIDE = 3;
const MAX_LABEL = 40;

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
  if (typeof o.label === "string" && o.label.trim()) hl.label = o.label.trim().slice(0, MAX_LABEL);
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
