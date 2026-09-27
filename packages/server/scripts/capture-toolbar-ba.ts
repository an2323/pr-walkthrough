/**
 * Capture BASE vs HEAD #10295: floating sidebar only (desktop).
 * Writes raw shots + probe JSON for each side.
 *
 *   pnpm --filter @pr-walkthrough/server exec tsx scripts/capture-toolbar-ba.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { loadWalkthrough } from "../src/storage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const VIEWPORT = { width: 1280, height: 800 };

const wt = await loadWalkthrough("excalidraw", "excalidraw", 10295);
if (!wt?.pr.baseSha || !wt.pr.headSha) throw new Error("no walkthrough SHAs");

const outDir = path.join(ROOT, "data/shots/excalidraw/excalidraw/10295");
await mkdir(outDir, { recursive: true });

function startVite(worktree: string, port: number): ChildProcess {
  return spawn(
    "yarn",
    ["--cwd", "excalidraw-app", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: worktree,
      env: { ...process.env, VITE_APP_PORT: String(port), BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

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

async function capture(label: string, sha: string, port: number) {
  const worktree = path.join(GIT_CACHE, "excalidraw__excalidraw", "wt", sha);
  if (!existsSync(path.join(worktree, "package.json"))) throw new Error(`missing ${worktree}`);
  const child = startVite(worktree, port);
  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  try {
    console.log(`${label} vite → :${port} (${sha.slice(0, 7)})`);
    await waitForHttp(`http://127.0.0.1:${port}`);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    try {
      await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle", timeout: 90_000 });
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
      await page.waitForTimeout(400);

      const probe = await page.evaluate(() => {
        const sidebar = document.querySelector(".sidebar");
        const toolbar = document.querySelector(".layer-ui__wrapper__top-right");
        const sr = sidebar?.getBoundingClientRect();
        const tr = toolbar?.getBoundingClientRect();
        const midX = sr ? sr.x + 40 : 1000;
        const midY = 30;
        const top = document.elementFromPoint(midX, midY);
        const zSidebar = sidebar ? getComputedStyle(sidebar).zIndex : null;
        const zToolbar = toolbar ? getComputedStyle(toolbar).zIndex : null;
        return {
          sidebar: sr && { x: sr.x, y: sr.y, w: sr.width, h: sr.height },
          toolbar: tr && { x: tr.x, y: tr.y, w: tr.width, h: tr.height },
          zSidebar,
          zToolbar,
          topAtSidebarHeader: top && {
            cls: String(top.className || "").slice(0, 100),
            inSidebar: !!top.closest(".sidebar"),
            inTopRight: !!top.closest(".layer-ui__wrapper__top-right"),
          },
        };
      });
      console.log(label, "probe", JSON.stringify(probe, null, 2));

      const raw = path.join(outDir, `symptom-toolbar-${label}-raw.png`);
      await page.screenshot({ path: raw, fullPage: false });
      await writeFile(path.join(outDir, `symptom-toolbar-${label}-probe.json`), JSON.stringify(probe, null, 2));
      console.log("wrote", raw);
      return probe;
    } finally {
      await browser.close();
    }
  } finally {
    kill();
  }
}

await capture("before", wt.pr.baseSha, 3022);
await capture("after", wt.pr.headSha, 3023);
console.log("done");
