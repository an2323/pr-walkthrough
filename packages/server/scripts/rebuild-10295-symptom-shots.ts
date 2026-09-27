/**
 * Rebuild #10295 symptom PNGs for the demo cards:
 *  - toolbar: BEFORE-only crop (no BASE|HEAD collage)
 *  - mobile: raw shot (no red overlay labels — card caption carries the text)
 *
 *   pnpm --filter @pr-walkthrough/server exec tsx scripts/rebuild-10295-symptom-shots.ts
 */
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(ROOT, "data/shots/excalidraw/excalidraw/10295");
const beforeRaw = path.join(dir, "symptom-toolbar-before-raw.png");
const outToolbar = path.join(dir, "symptom-toolbar-over-sidebar.png");
const mobileRaw = path.join(dir, "symptom-menu-under-sidebar-mobile-raw.png");
const outMobile = path.join(dir, "symptom-menu-under-sidebar-mobile.png");

const buf = await readFile(beforeRaw);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
// CSS 1280×800 region around the top-right toolbar + sidebar edge; raw is 2×.
const sx = w / 1280;
const sy = h / 800;
const clip = {
  x: Math.round(900 * sx),
  y: 0,
  width: Math.round(380 * sx),
  height: Math.round(260 * sy),
};

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: clip.width, height: clip.height },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;overflow:hidden">
      <div style="width:${clip.width}px;height:${clip.height}px;overflow:hidden">
        <img src="data:image/png;base64,${buf.toString("base64")}"
             style="display:block;width:${w}px;height:${h}px;margin-left:-${clip.x}px;margin-top:-${clip.y}px">
      </div>
    </body></html>`,
    { waitUntil: "load" }
  );
  await page.locator("div").first().screenshot({ path: outToolbar });
  console.log("toolbar BEFORE crop", clip, "→", outToolbar);
} finally {
  await browser.close();
}

await copyFile(mobileRaw, outMobile);
console.log("mobile → raw (no red label overlays)");
