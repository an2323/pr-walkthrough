/**
 * Mobile BASE screenshot: sidebar covers the open main menu.
 * Simulates the post-z-index-raise stacking (sidebar above menu) which is why
 * the PR also closes the sidebar when opening the menu.
 *
 *   pnpm --filter @pr-walkthrough/server exec tsx scripts/capture-mobile-symptom.ts
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadWalkthrough } from "../src/storage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const PORT = 3021;
const VIEWPORT = { width: 390, height: 844 };

const wt = await loadWalkthrough("excalidraw", "excalidraw", 10295);
if (!wt?.pr.baseSha) throw new Error("no walkthrough");
const baseWt = path.join(GIT_CACHE, "excalidraw__excalidraw", "wt", wt.pr.baseSha);
if (!existsSync(path.join(baseWt, "package.json"))) throw new Error(`missing worktree ${baseWt}`);

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
let killed = false;
const kill = () => {
  if (killed) return;
  killed = true;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
};
process.on("exit", kill);
process.on("SIGINT", () => {
  kill();
  process.exit(1);
});

async function waitForHttp(url: string, ms = 120_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
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

    await page.locator('label[title="Library"]').first().click({ force: true });
    await page.waitForTimeout(600);
    const docked = page.locator("button.sidebar__dock.selected");
    if (await docked.count()) {
      await docked.click({ force: true });
      await page.waitForTimeout(400);
    }

    // After the PR raises sidebar z-index above the top bar, the open menu sits
    // under the sidebar. Force that stacking on BASE so the symptom is visible.
    await page.addStyleTag({
      content: `
        .sidebar { z-index: 200 !important; }
        .dropdown-menu.main-menu-dropdown,
        .dropdown-menu--mobile { z-index: 90 !important; }
      `,
    });

    await page.locator("button.main-menu-trigger").first().click({ force: true });
    await page.waitForTimeout(800);

    const probe = await page.evaluate(() => {
      const menu = document.querySelector(".dropdown-menu.main-menu-dropdown");
      const sidebar = document.querySelector(".sidebar");
      const mr = menu?.getBoundingClientRect();
      const sr = sidebar?.getBoundingClientRect();
      const midX = mr ? mr.x + Math.min(mr.width * 0.7, 180) : 160;
      const midY = mr ? mr.y + 140 : 200;
      const topEl = document.elementFromPoint(midX, midY);
      return {
        menuBox: mr && { x: mr.x, y: mr.y, w: mr.width, h: mr.height },
        sidebarBox: sr && { x: sr.x, y: sr.y, w: sr.width, h: sr.height },
        topAtOverlap: topEl && {
          cls: String(topEl.className || "").slice(0, 100),
          text: (topEl.textContent || "").trim().slice(0, 50),
        },
      };
    });
    console.log("probe", JSON.stringify(probe, null, 2));

    const rawPath = path.join(outDir, "symptom-menu-under-sidebar-mobile-raw.png");
    await page.screenshot({ path: rawPath, fullPage: false });
    console.log("wrote", rawPath);
  } finally {
    await browser.close();
  }
} finally {
  kill();
}
