/**
 * verify-shots.ts — ST6e $0 fallback: take before/after screenshots for a cached walkthrough.
 *
 *   pnpm --filter @pr-walkthrough/server verify-shots excalidraw/excalidraw#10295
 *
 * Uses local git worktrees + Playwright (no Bob). Only Excalidraw #10295 is wired today.
 * Writes data/shots/{owner}/{repo}/{number}/{before,after}.png and patches the first
 * Problem step's visual to type "shots".
 */
import "../src/env.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadWalkthrough, saveWalkthrough } from "../src/storage.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GIT_CACHE = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";

const spec = process.argv[2] ?? "excalidraw/excalidraw#10295";
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(spec);
if (!m) throw new Error(`Expected owner/repo#number, got ${spec}`);
const [, owner, repo, numStr] = m;
const number = parseInt(numStr, 10);

if (owner !== "excalidraw" || repo !== "excalidraw" || number !== 10295) {
  throw new Error("verify-shots fallback currently supports only excalidraw/excalidraw#10295");
}

const wt = await loadWalkthrough(owner, repo, number);
if (!wt?.pr.baseSha || !wt.pr.headSha) throw new Error(`No walkthrough / SHAs for ${spec}`);

const cacheRepo = path.join(GIT_CACHE, `${owner}__${repo}`);
const baseWt = path.join(cacheRepo, "wt", wt.pr.baseSha);
const headWt = path.join(cacheRepo, "wt", wt.pr.headSha);
const BASE_PORT = 3010;
const HEAD_PORT = 3011;

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function ensureWorktree(sha: string, dest: string) {
  if (existsSync(path.join(dest, "package.json"))) return;
  await mkdir(path.dirname(dest), { recursive: true });
  await run("git", ["-C", cacheRepo, "fetch", "origin", sha]);
  await run("git", ["-C", cacheRepo, "worktree", "add", dest, sha]);
}

async function ensureInstall(dir: string) {
  if (existsSync(path.join(dir, "node_modules", "vite"))) return;
  await run("yarn", ["install"], { cwd: dir });
}

function startVite(dir: string, port: number) {
  const child = spawn(
    "yarn",
    ["--cwd", "excalidraw-app", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: dir,
      env: { ...process.env, VITE_APP_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  return child;
}

async function waitForHttp(url: string, ms = 120_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Playwright recipe for #10295: floating library sidebar, then open main menu. */
async function capture(port: number, outFile: string) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      document.querySelectorAll(".excalidraw-modal-container").forEach((n) => n.remove());
    });
    await page.locator('label[title="Library"]').first().click({ force: true });
    await page.waitForTimeout(500);
    const docked = page.locator("button.sidebar__dock.selected");
    if (await docked.count()) {
      await docked.click({ force: true });
      await page.waitForTimeout(400);
    }
    await page.locator("button.main-menu-trigger").first().click({ force: true });
    await page.waitForTimeout(600);
    await mkdir(path.dirname(outFile), { recursive: true });
    await page.screenshot({ path: outFile });
  } finally {
    await browser.close();
  }
}

console.log(`verify-shots ${spec}`);
console.log(`  base ${wt.pr.baseSha.slice(0, 7)} → :${BASE_PORT}`);
console.log(`  head ${wt.pr.headSha.slice(0, 7)} → :${HEAD_PORT}`);

if (!existsSync(cacheRepo)) {
  throw new Error(`Missing clone at ${cacheRepo} — run an analyze once or clone excalidraw there`);
}

await ensureWorktree(wt.pr.baseSha, baseWt);
await ensureWorktree(wt.pr.headSha, headWt);
await ensureInstall(baseWt);
await ensureInstall(headWt);

const baseProc = startVite(baseWt, BASE_PORT);
const headProc = startVite(headWt, HEAD_PORT);
const shotsDir = path.join(ROOT, "data/shots", owner, repo, String(number));
const beforePath = path.join(shotsDir, "before.png");
const afterPath = path.join(shotsDir, "after.png");

try {
  await waitForHttp(`http://127.0.0.1:${BASE_PORT}/`);
  await waitForHttp(`http://127.0.0.1:${HEAD_PORT}/`);
  await capture(BASE_PORT, beforePath);
  await capture(HEAD_PORT, afterPath);
} finally {
  baseProc.kill("SIGTERM");
  headProc.kill("SIGTERM");
}

// Patch first problem / symptom step with shots visual
const first = wt.steps.find((s) => s.kind === "symptom") ?? wt.steps[0];
first.visual = {
  type: "shots",
  caption: "Open the library sidebar, then open the main menu.",
  before: {
    src: "before.png",
    highlights: [
      { x: 0.01, y: 0.06, w: 0.26, h: 0.62, label: "Main menu opens" },
      { x: 0.77, y: 0.0, w: 0.23, h: 1.0, label: "Sidebar still covers the UI" },
    ],
  },
  after: {
    src: "after.png",
    highlights: [
      { x: 0.01, y: 0.06, w: 0.26, h: 0.62, label: "Main menu is clear" },
      { x: 0.78, y: 0.0, w: 0.2, h: 0.08, label: "Sidebar closed with the menu" },
    ],
  },
};
await saveWalkthrough(wt);

// Recipe note for ST6e / Bob verifier
await writeFile(
  path.join(shotsDir, "RECIPE.md"),
  `# Screenshot recipe — ${spec}

1. Worktrees at BASE \`${wt.pr.baseSha}\` and HEAD \`${wt.pr.headSha}\`.
2. \`yarn install\` + \`VITE_APP_PORT=<port> yarn --cwd excalidraw-app vite\`.
3. Dismiss \`.excalidraw-modal-container\`.
4. Click \`label[title="Library"]\`; undock if \`button.sidebar__dock.selected\`.
5. Click \`button.main-menu-trigger\`.
6. Screenshot 1280×800.

Before: sidebar stays open with the menu (bug).
After: opening the menu closes the undocked sidebar (fix).
`,
  "utf8"
);

console.log(`wrote ${beforePath}`);
console.log(`wrote ${afterPath}`);
console.log(`updated walkthrough step ${first.id} visual → shots`);
