/**
 * Build a BEFORE-only symptom shot from the labeled BASE|HEAD collage
 * (left panel + a clean title), cache-busted filename for the viewer.
 *
 *   pnpm --filter @pr-walkthrough/server exec tsx scripts/extract-toolbar-before.ts
 */
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(ROOT, "data/shots/excalidraw/excalidraw/10295");
const collagePath = path.join(dir, ".tmp-toolbar-collage.png");
const outPath = path.join(dir, "symptom-toolbar-before.png");

await mkdir(dir, { recursive: true });
const { stdout } = await execFileAsync(
  "git",
  ["show", "HEAD:data/shots/excalidraw/excalidraw/10295/symptom-toolbar-over-sidebar.png"],
  { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" }
);
await writeFile(collagePath, stdout);

const buf = await readFile(collagePath);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
const half = Math.floor(w / 2);

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: half, height: h },
    deviceScaleFactor: 1,
  });
  // Left half of the collage, with the shared BA title replaced by a BEFORE-only banner.
  await page.setContent(
    `<!doctype html><html><head><style>
      html,body{margin:0;background:#111}
      .wrap{position:relative;width:${half}px;height:${h}px;overflow:hidden}
      .wrap img{display:block;width:${w}px;height:${h}px;max-width:none}
      .banner{position:absolute;left:0;top:0;right:0;height:28px;display:flex;align-items:center;
        justify-content:center;background:#da1e28;color:#fff;
        font:600 12px/1.2 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;letter-spacing:.01em}
    </style></head><body>
      <div class="wrap">
        <img src="data:image/png;base64,${buf.toString("base64")}">
        <div class="banner">BEFORE · toolbar sits above the open sidebar</div>
      </div>
    </body></html>`,
    { waitUntil: "load" }
  );
  await page.locator(".wrap").screenshot({ path: outPath });
  console.log(`BEFORE ${half}x${h} → ${outPath}`);
} finally {
  await browser.close();
}
try {
  await unlink(collagePath);
} catch {
  /* ignore */
}
