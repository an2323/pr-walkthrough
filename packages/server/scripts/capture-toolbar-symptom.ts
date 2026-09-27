/**
 * Desktop BASE: floating sidebar open, top-right toolbar sitting on top of it.
 *   pnpm --filter @pr-walkthrough/server exec tsx scripts/capture-toolbar-symptom.ts
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadWalkthrough } from "../src/storage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const PORT = 3022;
const VIEWPORT = { width: 1280, height: 800 };

const wt = await loadWalkthrough("excalidraw", "excalidraw", 10295);
if (!wt?.pr.baseSha) throw new Error("no walkthrough");
const baseWt = path.join(GIT_CACHE, "excalidraw__excalidraw", "wt", wt.pr.baseSha);
if (!existsSync(path.join(baseWt, "package.json"))) throw new Error(`missing ${baseWt}`);

const outDir = path.join(ROOT, "data/shots/excalidraw/excalidraw/10295");
await mkdir(outDir, { recursive: true });

const child = spawn(
  "yarn",
  ["--cwd", "excalidraw-app", "vite", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  {
    cwd: baseWt,
    env: { ...process.env, VITE_APP_PORT: String(PORT), BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  }
);
const kill = () => {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
};
process.on("exit", kill);

async function waitForHttp(url: string, ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout ${url}`);
}

try {
  console.log(`BASE vite → :${PORT}`);
  await waitForHttp(`http://127.0.0.1:${PORT}`);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  try {
    await page.goto(`http://127.0.0.1:${PORT}`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      document.querySelectorAll(".excalidraw-modal-container").forEach((n) => n.remove());
    });

    // Floating library only — no main menu (keeps the stacking bug unambiguous)
    await page.locator('label[title="Library"]').first().click({ force: true });
    await page.waitForTimeout(600);
    const docked = page.locator("button.sidebar__dock.selected");
    if (await docked.count()) {
      await docked.click({ force: true });
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(400);

    const probe = await page.evaluate(() => {
      const sidebar = document.querySelector(".sidebar");
      // Top-right island: search / library / etc.
      const toolbar =
        document.querySelector(".layer-ui__wrapper__top-right") ||
        document.querySelector(".App-toolbar--top") ||
        document.querySelector('[class*="top-right"]');
      const sr = sidebar?.getBoundingClientRect();
      const tr = toolbar?.getBoundingClientRect();
      // Fallback: buttons near the top-right
      const btns = [...document.querySelectorAll("button, label")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top < 60 && r.right > window.innerWidth - 280 && r.width > 20 && r.height > 20;
      });
      return {
        sidebar: sr && { x: sr.x, y: sr.y, w: sr.width, h: sr.height },
        toolbar: tr && { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
        toolbarClass: toolbar?.className?.toString().slice(0, 120),
        topRightBtns: btns.slice(0, 8).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            title: el.getAttribute("title") || el.getAttribute("aria-label") || "",
            x: r.x,
            y: r.y,
            w: r.width,
            h: r.height,
          };
        }),
      };
    });
    console.log("probe", JSON.stringify(probe, null, 2));

    const rawPath = path.join(outDir, "symptom-toolbar-over-sidebar-raw.png");
    await page.screenshot({ path: rawPath, fullPage: false });
    console.log("wrote", rawPath);

    // Persist probe for the Pillow annotator
    await mkdir(outDir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(outDir, "symptom-toolbar-over-sidebar-probe.json"), JSON.stringify(probe, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  kill();
}
