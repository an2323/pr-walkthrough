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

export type ShotTone = "bad" | "good";

export interface AnnotateOpts {
  crop?: CropRegion;
  /** Draw label pills only — no border rectangles around the marked regions. */
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

/** Tall boxes get the label inside at the bottom; small ones below (or above, near the bottom edge). */
function labelStyle(h: ShotHighlight): string {
  // Boxes in the right half anchor the label to their right edge, so it can't run off the image.
  const right = h.x + h.w / 2 > 0.5;
  const side = right ? "right:-4px;" : "left:-4px;";
  if (h.h > 0.25) return right ? "right:8px;bottom:8px;" : "left:8px;bottom:8px;";
  if (h.y + h.h > 0.88) return `${side}bottom:calc(100% + 6px);`;
  return `${side}top:calc(100% + 6px);`;
}

/** Full-width strip near the top → render as a banner bar (title), not a floating pill. */
function isBanner(h: ShotHighlight): boolean {
  return !!h.label && h.w >= 0.85 && h.y <= 0.08 && h.h <= 0.12;
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
  const labelsOnly = !!opts.labelsOnly;

  const buf = await readFile(rawPath);
  const { width, height } = pngSize(buf);
  // A crop is an upscale of pixels that were already captured. On a big desktop capture that makes a
  // small change legible; on a phone-sized frame (a few hundred px wide) it only produces a blurry,
  // mostly empty enlargement — there the whole frame with a tight box reads better.
  const crop = width >= MIN_CROP_SOURCE_WIDTH ? opts.crop : undefined;
  const color = COLORS[tone];
  // A label wraps within whichever is narrower: the crop (if any) or the full image —
  // otherwise a crop tight enough to need one in the first place lets the label run
  // straight off its edge (seen on #10943's first render before this fix).
  const labelMaxWidth = Math.round((crop ? crop.w * width : width) * 0.85);
  const labelFontPx = crop ? 15 : 20; // a crop is already a zoomed-in view — a 20px label wraps to too many lines
  const boxBorder = labelsOnly
    ? "border:none;box-shadow:none;background:transparent;"
    : `border:4px solid ${color};border-radius:10px;box-shadow:0 0 0 2px rgba(255,255,255,.85);`;
  const boxes = highlights
    .map((h) => {
      if (!h.label) {
        if (labelsOnly) return ""; // nothing to draw without a label
        return `<div class="box" style="left:${h.x * 100}%;top:${h.y * 100}%;width:${h.w * 100}%;height:${h.h * 100}%;${boxBorder}"></div>`;
      }
      if (isBanner(h)) {
        return `<div class="banner" style="left:${h.x * 100}%;top:${h.y * 100}%;width:${h.w * 100}%;height:${Math.max(h.h, 0.045) * 100}%">${esc(h.label)}</div>`;
      }
      // Labels-only: anchor a zero-size point so the pill sits where the box's
      // top-left was, without drawing a rectangle.
      if (labelsOnly) {
        // Keep the pill inside the picture: start no further right than leaves room for a short label,
        // and let it use whatever width remains (a pill in a zero-width anchor would otherwise wrap
        // every word onto its own line).
        const startX = Math.min(h.x, Math.max(0, 1 - 220 / width));
        const room = Math.max(160, Math.round((1 - startX) * width - 16));
        // The pill goes just BELOW the marked spot (above it when the spot is at the bottom edge) so it
        // never covers the very thing it points at.
        // Room below → below. Otherwise above, if there is room above; a box spanning the whole height
        // (a panel) has neither, so the pill sits just inside its top edge instead of off the picture.
        const mode: "below" | "above" | "inside" = h.y + h.h <= 0.88 ? "below" : h.y > 0.12 ? "above" : "inside";
        const anchorY = mode === "below" ? h.y + h.h : h.y;
        const place = mode === "below" ? "top:6px;" : mode === "above" ? "top:0;transform:translateY(calc(-100% - 6px));" : "top:8px;";
        return `<div class="box" style="left:${startX * 100}%;top:${anchorY * 100}%;width:0;height:0;border:none;box-shadow:none"><span class="lbl" style="left:0;${place}max-width:${room}px">${esc(h.label)}</span></div>`;
      }
      return `<div class="box" style="left:${h.x * 100}%;top:${h.y * 100}%;width:${h.w * 100}%;height:${h.h * 100}%;${boxBorder}">${
        `<span class="lbl" style="${labelStyle(h)}">${esc(h.label)}</span>`
      }</div>`;
    })
    .join("");
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0}
    .wrap{position:relative;width:${width}px;height:${height}px;overflow:hidden}
    .wrap img{display:block;width:100%;height:100%}
    .box{position:absolute;box-sizing:border-box}
    .banner{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
      text-align:center;padding:4px 10px;color:#fff;background:${color};
      font:600 ${labelFontPx}px/1.25 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
      box-shadow:0 2px 6px rgba(0,0,0,.25)}
    .lbl{position:absolute;width:max-content;max-width:min(360px,${labelMaxWidth}px);white-space:normal;
      font:600 ${labelFontPx}px/1.25 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
      color:#fff;background:${color};padding:5px 12px;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.25)}
  </style></head><body><div class="wrap"><img src="data:image/png;base64,${buf.toString("base64")}">${boxes}</div></body></html>`;

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    // A crop is rendered at a higher deviceScaleFactor so its OUTPUT pixel size stays
    // legible even though the visible region (in CSS px) is small — supersampling the
    // already-captured screenshot, not adding real detail, but enough to read clearly.
    const cropPx = crop ? { x: crop.x * width, y: crop.y * height, width: crop.w * width, height: crop.h * height } : undefined;
    const scale = cropPx ? Math.min(CROP_MAX_SCALE, Math.max(1, CROP_MIN_WIDTH / cropPx.width)) : 1;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.setContent(html, { waitUntil: "load" });
    await mkdir(path.dirname(outPath), { recursive: true });
    if (cropPx) {
      await page.screenshot({ path: outPath, clip: cropPx });
    } else {
      await page.locator(".wrap").screenshot({ path: outPath });
    }
  } finally {
    await browser.close();
  }
}
