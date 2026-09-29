/**
 * annotate.ts — draw highlight boxes and labels into a screenshot, so the marks are
 * part of the image (they survive zooming, downloading, pasting into a PR comment).
 * Optionally crops to a shared region (verify/highlights.ts's `maybeCropRegion`) when
 * the marked change is a small fraction of a large screenshot, so the reader isn't
 * left hunting for a small box on a full desktop capture.
 */
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ShotHighlight } from "@pr-walkthrough/shared";
import type { CropRegion } from "../verify/highlights.js";
import { decodePng, type Decoded } from "./png-diff.js";

export type ShotTone = "bad" | "good";

export interface AnnotateOpts {
  crop?: CropRegion;
  /** Symptom card: always number the marks (the legend is read apart from the main pair). */
  labelsOnly?: boolean;
}

const COLORS: Record<ShotTone, string> = { bad: "#da1e28", good: "#198038" };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.toString("ascii", 12, 16) !== "IHDR") throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * The labels never sit ON the picture. On a dense frame (a phone viewport full of menu items) there
 * is no free spot for a pill, and every placement rule still covered something the reader needed.
 * So the frame only gets the rectangle (and a small number when there's more than one label, or no
 * rectangle to show where), and the words go into a legend strip under the frame.
 */
export function buildAnnotationHtml(
  pngBase64: string,
  size: { width: number; height: number },
  highlights: ShotHighlight[],
  tone: ShotTone,
  opts: { crop?: CropRegion; labelsOnly?: boolean; pixels?: Decoded | null } = {}
): string {
  const { width, height } = size;
  const color = COLORS[tone];
  const crop = opts.crop;
  const cx = crop ? crop.x * width : 0;
  const cy = crop ? crop.y * height : 0;
  const W = crop ? crop.w * width : width;
  const H = crop ? crop.h * height : height;
  // Legend text scales with the frame: ~15px on a phone frame, 20px on a desktop one, never below 12.
  const fontPx = Math.round(Math.max(12, Math.min(20, W * 0.04)));
  const badge = Math.round(fontPx * 1.5);

  const labeled = highlights.filter((h) => h.label?.trim());
  const numbered = !!opts.labelsOnly || labeled.length > 1;

  // Boxes on cards too: with the words in the legend, the box is what shows WHERE a number points.
  const boxes = highlights
        .map(
          (h) =>
            `<div class="box" style="left:${h.x * width - cx}px;top:${h.y * height - cy}px;width:${h.w * width}px;height:${h.h * height}px"></div>`
        )
        .join("");
  const spots = numbered ? placeBadges(labeled, { width, height, cx, cy, W, H }, badge, opts.pixels) : [];
  const badges = spots.map((p, i) => `<div class="badge" style="left:${p.x}px;top:${p.y}px">${i + 1}</div>`).join("");
  const legend = labeled.length
    ? `<div class="legend">${labeled
        .map((h, i) => `<div class="item">${numbered ? `<span class="n">${i + 1}</span>` : `<span class="dot"></span>`}<span>${esc(h.label!.trim())}</span></div>`)
        .join("")}</div>`
    : "";

  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:#fff}
    .card{display:inline-block;width:${W}px;background:#fff}
    .frame{position:relative;width:${W}px;height:${H}px;overflow:hidden}
    .frame img{position:absolute;left:${-cx}px;top:${-cy}px;width:${width}px;height:${height}px;display:block}
    .box{position:absolute;box-sizing:border-box;border:${Math.max(2, Math.round(fontPx / 5))}px solid ${color};border-radius:8px;box-shadow:0 0 0 2px rgba(255,255,255,.85)}
    .badge{position:absolute;width:${badge}px;height:${badge}px;border-radius:50%;background:${color};color:#fff;
      font:700 ${fontPx}px/${badge}px -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;text-align:center;
      box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.3)}
    .legend{border-top:3px solid ${color};padding:${Math.round(fontPx * 0.5)}px ${Math.round(fontPx * 0.7)}px;
      font:600 ${fontPx}px/1.3 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#161616}
    .item{display:flex;align-items:flex-start;gap:${Math.round(fontPx * 0.5)}px;padding:${Math.round(fontPx * 0.2)}px 0}
    .n{flex:none;width:${badge}px;height:${badge}px;border-radius:50%;background:${color};color:#fff;text-align:center;line-height:${badge}px;font-weight:700}
    .dot{flex:none;width:${Math.round(fontPx * 0.7)}px;height:${Math.round(fontPx * 0.7)}px;margin-top:${Math.round(fontPx * 0.3)}px;border-radius:3px;background:${color}}
  </style></head><body><div class="card"><div class="frame"><img src="data:image/png;base64,${pngBase64}">${boxes}${badges}</div>${legend}</div></body></html>`;
}

type Rect = { x: number; y: number; w: number; h: number };
const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** How "busy" the picture is under a rect (0 = flat background): luminance spread, sampled. */
function busyness(px: Decoded, r: Rect): number {
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

/**
 * Where each number goes (frame coords). A number must point at its box without hiding what the
 * box marks, another number, or busy content: candidates around each box are scored on exactly
 * that, and the least harmful spot wins. Rules, not hand-placed positions — every PR's frames differ.
 */
export function placeBadges(
  labeled: ShotHighlight[],
  g: { width: number; height: number; cx: number; cy: number; W: number; H: number },
  s: number,
  pixels?: Decoded | null
): { x: number; y: number }[] {
  const boxes: Rect[] = labeled.map((h) => ({ x: h.x * g.width - g.cx, y: h.y * g.height - g.cy, w: h.w * g.width, h: h.h * g.height }));
  const gap = 3;
  const placed: Rect[] = [];
  return boxes.map((b, i) => {
    const cands: { x: number; y: number }[] = [
      { x: b.x - s - gap, y: b.y }, // left of the top-left corner
      { x: b.x, y: b.y - s - gap }, // above the top-left corner
      { x: b.x + b.w - s, y: b.y - s - gap }, // above the top-right corner
      { x: b.x + b.w + gap, y: b.y }, // right of the top-right corner
      { x: b.x, y: b.y + b.h + gap }, // below the bottom-left corner
      { x: b.x - s - gap, y: b.y + b.h - s }, // left of the bottom-left corner
      { x: b.x - s / 2, y: b.y - s / 2 }, // on the corner
      { x: b.x + 4, y: b.y + 4 }, // inside, top-left
    ];
    let best: { x: number; y: number } | undefined;
    let bestScore = Infinity;
    cands.forEach((c, k) => {
      const r: Rect = { x: c.x, y: c.y, w: s, h: s };
      if (r.x < 2 || r.y < 2 || r.x + s > g.W - 2 || r.y + s > g.H - 2) return;
      const area = s * s;
      let score = k * 0.03; // prefer the nearer, conventional spots when all else is equal
      score += (overlap(r, b) / area) * 1.5; // covering the thing it marks
      boxes.forEach((o, j) => { if (j !== i) score += (overlap(r, o) / area) * 0.6; });
      for (const p of placed) score += (overlap(r, p) / area) * 10;
      if (pixels) score += busyness(pixels, { x: r.x + g.cx, y: r.y + g.cy, w: s, h: s }) * 2;
      if (score < bestScore) { bestScore = score; best = c; }
    });
    const spot = best ?? { x: Math.max(2, Math.min(g.W - s - 2, b.x + 4)), y: Math.max(2, Math.min(g.H - s - 2, b.y + 4)) };
    placed.push({ ...spot, w: s, h: s });
    return spot;
  });
}

/** Minimum width (CSS px) a crop is upscaled to via deviceScaleFactor, so a tiny marked area still reads clearly. */
const CROP_MIN_WIDTH = 640;
const CROP_MAX_SCALE = 3;
/** Frames narrower than this are never cropped (see annotateShot). */
export const MIN_CROP_SOURCE_WIDTH = 700;

export async function annotateShot(
  rawPath: string,
  outPath: string,
  highlights: ShotHighlight[],
  tone: ShotTone,
  cropOrOpts?: CropRegion | AnnotateOpts
): Promise<void> {
  const opts: AnnotateOpts =
    cropOrOpts && typeof cropOrOpts === "object" && ("crop" in cropOrOpts || "labelsOnly" in cropOrOpts)
      ? (cropOrOpts as AnnotateOpts)
      : { crop: cropOrOpts as CropRegion | undefined };

  const buf = await readFile(rawPath);
  const { width, height } = pngSize(buf);
  // A crop is an upscale of pixels that were already captured. On a big desktop capture that makes a
  // small change legible; on a phone-sized frame (a few hundred px wide) it only produces a blurry,
  // mostly empty enlargement — there the whole frame with a tight box reads better.
  const crop = width >= MIN_CROP_SOURCE_WIDTH ? opts.crop : undefined;
  const html = buildAnnotationHtml(buf.toString("base64"), { width, height }, highlights, tone, {
    crop,
    labelsOnly: !!opts.labelsOnly,
    pixels: decodePng(buf),
  });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    // A crop is rendered at a higher deviceScaleFactor so its OUTPUT pixel size stays
    // legible even though the visible region (in CSS px) is small — supersampling the
    // already-captured screenshot, not adding real detail, but enough to read clearly.
    const frameW = crop ? crop.w * width : width;
    const scale = crop ? Math.min(CROP_MAX_SCALE, Math.max(1, CROP_MIN_WIDTH / frameW)) : 1;
    const page = await browser.newPage({ viewport: { width: Math.ceil(frameW), height: height + 400 }, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: "load" });
    await mkdir(path.dirname(outPath), { recursive: true });
    await page.locator(".card").screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}
