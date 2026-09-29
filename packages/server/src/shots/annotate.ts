/**
 * annotate.ts — draw highlight boxes and short labels into a DESKTOP screenshot, so the marks are
 * part of the image (they survive zooming, downloading, pasting into a PR comment).
 *
 * The look (agreed reference for #10295):
 *  - a box is the whole element its label names, never a slice of it;
 *  - an element that the fix removed is drawn dashed where it used to be (`gone`);
 *  - a label is a small pill in EMPTY space next to its box — placed by scoring the candidate spots
 *    (busy pixels, other pills, frame edges), never by a fixed offset that lands on content.
 * Phone frames are not drawn on at all (shots/frames.ts) — the callers skip this module for them.
 * Optionally crops to a shared region (verify/highlights.ts's `maybeCropRegion`) when the marked
 * change is a small fraction of a large screenshot.
 */
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ShotHighlight } from "@pr-walkthrough/shared";
import type { CropRegion } from "../verify/highlights.js";
import { decodePng, type Decoded } from "./png-diff.js";
import { pngDimensions } from "./frames.js";

export type ShotTone = "bad" | "good";

export interface AnnotateOpts {
  crop?: CropRegion;
}

const COLORS: Record<ShotTone, string> = { bad: "#da1e28", good: "#198038" };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Minimum width (CSS px) a crop is upscaled to via deviceScaleFactor, so a tiny marked area still reads clearly. */
const CROP_MIN_WIDTH = 560;
const CROP_MAX_SCALE = 2;
/** Frames narrower than this are never cropped. */
export const MIN_CROP_SOURCE_WIDTH = 700;

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** How "busy" the picture is under a rect (0 = flat background): luminance spread, sampled. */
export function busyness(px: Decoded, r: Rect): number {
  let n = 0, sum = 0, sq = 0;
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(px.width, Math.ceil(r.x + r.w)), y1 = Math.min(px.height, Math.ceil(r.y + r.h));
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * px.width + x) * px.channels;
      const l = px.channels >= 3 ? 0.3 * px.data[i] + 0.59 * px.data[i + 1] + 0.11 * px.data[i + 2] : px.data[i];
      n++; sum += l; sq += l * l;
    }
  }
  if (!n) return 1;
  const mean = sum / n;
  return Math.min(1, Math.sqrt(Math.max(0, sq / n - mean * mean)) / 60);
}

/** Pill size for a label at a given font size (a text measure is not available before rendering). */
export function pillSize(text: string, fontPx: number): { w: number; h: number } {
  return { w: Math.round(text.length * fontPx * 0.56 + fontPx * 1.5), h: Math.round(fontPx * 1.9) };
}

/**
 * Where each label's pill goes (full-image px). Candidate spots hug the box: beside it, below, above,
 * or inside its edge. The least harmful wins: it must stay inside `area`, avoid busy pixels (the
 * content of the app), avoid the other pills, and keep off the other boxes.
 */
export function placePills(
  items: { box: Rect; label: string }[],
  area: Rect,
  fontPx: number,
  pixels?: Decoded | null
): { x: number; y: number; w: number; h: number }[] {
  const gap = 10;
  const boxes = items.map((i) => i.box);
  const placed: Rect[] = [];
  return items.map((it, i) => {
    const b = it.box;
    const { w, h } = pillSize(it.label, fontPx);
    const cands: { x: number; y: number }[] = [
      { x: b.x + b.w + gap, y: b.y + b.h - h }, // right of the box, bottom-aligned
      { x: b.x - gap - w, y: b.y + b.h - h }, // left of the box, bottom-aligned
      { x: b.x, y: b.y + b.h + gap }, // below
      { x: b.x, y: b.y - h - gap }, // above
      { x: b.x + b.w + gap, y: b.y }, // right, top-aligned
      { x: b.x - gap - w, y: b.y }, // left, top-aligned
      { x: b.x + b.w - w - gap, y: b.y + b.h - h - gap }, // inside, bottom-right
      { x: b.x + gap, y: b.y + b.h - h - gap }, // inside, bottom-left
      { x: b.x + b.w - w - gap, y: b.y + gap }, // inside, top-right
      { x: b.x + gap, y: b.y + gap }, // inside, top-left
      { x: b.x + b.w - w - gap, y: b.y + b.h / 2 - h / 2 }, // inside, middle right
    ];
    // Also try a few heights along the box's sides: the bottom is not always the empty part.
    for (const f of [0.25, 0.5, 0.75]) {
      cands.push({ x: b.x + b.w + gap, y: b.y + b.h * f - h / 2 });
      cands.push({ x: b.x - gap - w, y: b.y + b.h * f - h / 2 });
      cands.push({ x: b.x + b.w - w - gap, y: b.y + b.h * f - h / 2 });
    }
    let best: Rect | undefined;
    let bestScore = Infinity;
    cands.forEach((c, k) => {
      const r: Rect = { x: c.x, y: c.y, w, h };
      if (r.x < area.x + 2 || r.y < area.y + 2 || r.x + w > area.x + area.w - 2 || r.y + h > area.y + area.h - 2) return;
      const a = w * h;
      let score = k * 0.02; // earlier candidates hug the box more conventionally
      score += (overlap(r, b) / a) * 0.35; // inside its own box is fine, but outside is nicer
      boxes.forEach((o, j) => { if (j !== i) score += (overlap(r, o) / a) * 0.8; });
      for (const p of placed) score += (overlap(r, p) / a) * 20;
      if (pixels) score += busyness(pixels, r) * 4;
      if (score < bestScore) { bestScore = score; best = r; }
    });
    // Nothing fits inside the area (a tiny crop): clamp the first spot in rather than lose the label.
    const fallback: Rect = {
      x: Math.max(area.x + 2, Math.min(area.x + area.w - w - 2, b.x)),
      y: Math.max(area.y + 2, Math.min(area.y + area.h - h - 2, b.y + b.h + gap)),
      w, h,
    };
    const spot = best ?? fallback;
    placed.push(spot);
    return spot;
  });
}

/** The HTML the frame is rendered from (exported for tests). */
export function buildAnnotationHtml(
  pngBase64: string,
  size: { width: number; height: number },
  highlights: ShotHighlight[],
  tone: ShotTone,
  opts: { crop?: CropRegion; pixels?: Decoded | null } = {}
): string {
  const { width, height } = size;
  const color = COLORS[tone];
  const c = opts.crop;
  const area: Rect = c ? { x: c.x * width, y: c.y * height, w: c.w * width, h: c.h * height } : { x: 0, y: 0, w: width, h: height };
  // Label size follows the visible frame: ~19px on a 1280 frame, a bit smaller in a zoomed crop.
  const fontPx = Math.round(Math.max(13, Math.min(21, area.w * (c ? 0.03 : 0.015))));
  const border = Math.max(3, Math.round(fontPx / 5));

  const rects = highlights.map((h) => ({ x: h.x * width, y: h.y * height, w: h.w * width, h: h.h * height }));
  const boxes = highlights
    .map((h, i) => {
      const r = rects[i];
      const style = h.gone ? "dashed" : "solid";
      return `<div class="box" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border-style:${style}"></div>`;
    })
    .join("");
  const labeled = highlights.map((h, i) => ({ h, i })).filter((x) => x.h.label?.trim());
  const spots = placePills(
    labeled.map((x) => ({ box: rects[x.i], label: x.h.label!.trim() })),
    area,
    fontPx,
    opts.pixels
  );
  const pills = labeled
    .map((x, k) => `<div class="pill" style="left:${spots[k].x}px;top:${spots[k].y}px;height:${spots[k].h}px;line-height:${spots[k].h}px">${esc(x.h.label!.trim())}</div>`)
    .join("");

  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0}
    .wrap{position:relative;width:${width}px;height:${height}px;overflow:hidden}
    .wrap img{display:block;width:100%;height:100%}
    .box{position:absolute;box-sizing:border-box;border:${border}px solid ${color};border-radius:10px;box-shadow:0 0 0 2px rgba(255,255,255,.8)}
    .pill{position:absolute;box-sizing:border-box;padding:0 ${Math.round(fontPx * 0.7)}px;white-space:nowrap;color:#fff;background:${color};border-radius:7px;
      font:700 ${fontPx}px -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.3)}
  </style></head><body><div class="wrap"><img src="data:image/png;base64,${pngBase64}">${boxes}${pills}</div></body></html>`;
}

export async function annotateShot(
  rawPath: string,
  outPath: string,
  highlights: ShotHighlight[],
  tone: ShotTone,
  cropOrOpts?: CropRegion | AnnotateOpts
): Promise<void> {
  const opts: AnnotateOpts =
    cropOrOpts && typeof cropOrOpts === "object" && "crop" in cropOrOpts ? (cropOrOpts as AnnotateOpts) : { crop: cropOrOpts as CropRegion | undefined };

  const buf = await readFile(rawPath);
  const dim = pngDimensions(buf);
  if (!dim) throw new Error("not a PNG");
  const { width, height } = dim;
  // A crop is an upscale of pixels that were already captured. On a big desktop capture that makes a
  // small change legible; on a phone-sized frame it only produces a blurry, mostly empty enlargement.
  const crop = width >= MIN_CROP_SOURCE_WIDTH ? opts.crop : undefined;
  const html = buildAnnotationHtml(buf.toString("base64"), { width, height }, highlights, tone, { crop, pixels: decodePng(buf) });

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    // A crop is rendered at a higher deviceScaleFactor so its OUTPUT pixel size stays legible.
    const cropPx = crop ? { x: crop.x * width, y: crop.y * height, width: crop.w * width, height: crop.h * height } : undefined;
    const scale = cropPx ? Math.min(CROP_MAX_SCALE, Math.max(1, CROP_MIN_WIDTH / cropPx.width)) : 1;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: "load" });
    await mkdir(path.dirname(outPath), { recursive: true });
    if (cropPx) await page.screenshot({ path: outPath, clip: cropPx });
    else await page.locator(".wrap").screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}
