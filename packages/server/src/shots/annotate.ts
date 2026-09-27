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

/** Minimum width (CSS px) a crop is upscaled to via deviceScaleFactor, so a tiny marked area still reads clearly. */
const CROP_MIN_WIDTH = 640;
const CROP_MAX_SCALE = 3;

export async function annotateShot(
  rawPath: string,
  outPath: string,
  highlights: ShotHighlight[],
  tone: ShotTone,
  crop?: CropRegion
): Promise<void> {
  const buf = await readFile(rawPath);
  const { width, height } = pngSize(buf);
  const color = COLORS[tone];
  // A label wraps within whichever is narrower: the crop (if any) or the full image —
  // otherwise a crop tight enough to need one in the first place lets the label run
  // straight off its edge (seen on #10943's first render before this fix).
  const labelMaxWidth = Math.round((crop ? crop.w * width : width) * 0.85);
  const labelFontPx = crop ? 15 : 20; // a crop is already a zoomed-in view — a 20px label wraps to too many lines
  const boxes = highlights
    .map(
      (h) => `<div class="box" style="left:${h.x * 100}%;top:${h.y * 100}%;width:${h.w * 100}%;height:${h.h * 100}%">${
        h.label ? `<span class="lbl" style="${labelStyle(h)}">${esc(h.label)}</span>` : ""
      }</div>`
    )
    .join("");
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0}
    .wrap{position:relative;width:${width}px;height:${height}px;overflow:hidden}
    .wrap img{display:block;width:100%;height:100%}
    .box{position:absolute;box-sizing:border-box;border:4px solid ${color};border-radius:10px;
      box-shadow:0 0 0 2px rgba(255,255,255,.85)}
    .lbl{position:absolute;max-width:min(360px,${labelMaxWidth}px);white-space:normal;
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
