/**
 * app-servers.ts — install and run a repository's dev server at BASE and HEAD
 * for the screenshot verifier. The backend owns these processes (not Bob), so
 * it always knows what to stop: each server is spawned as the leader of its
 * own process group and the whole group is killed afterwards — yarn, vite and
 * anything they forked.
 *
 * Everything here runs the repository's own code (install scripts, dev
 * server), so it gets a scrubbed environment: no API keys or tokens from our
 * `.env`, only what a build needs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, statfs } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { AppRecipe } from "./recipes.js";

import { scrubbedEnv } from "../util/scrubbed-env.js";

export { ENV_KEEP, scrubbedEnv } from "../util/scrubbed-env.js";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // Own process group, so a timeout takes yarn's postinstall children with it (the
    // spawn `timeout` option only ever killed the leader).
    const child = spawn(cmd, args, { cwd, env: scrubbedEnv(extraEnv), detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGKILL");
    }, timeoutMs);
    child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const why = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exited ${code}`;
      reject(new Error(`${cmd} ${args.join(" ")} ${why}: ${stderr.trim().slice(-500)}`));
    });
  });
}

/** Every `node_modules` dir of a worktree (root + workspace packages), not descending into them. */
async function nodeModulesDirs(worktree: string): Promise<string[]> {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn("find", [worktree, "-maxdepth", "3", "-name", "node_modules", "-type", "d", "-prune"]);
    let s = "";
    child.stdout.on("data", (d: Buffer) => (s += d));
    child.on("error", reject);
    child.on("close", () => resolve(s));
  });
  return out.split("\n").filter(Boolean).map((p) => path.relative(worktree, p));
}

async function fileHash(p: string): Promise<string | undefined> {
  try {
    return createHash("sha1").update(await readFile(p)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * Install the app's dependencies in `worktree`, reusing an already-installed
 * sibling worktree (`<clone>/wt/*`) when there is one:
 *  1. its `node_modules` dirs are copied with `cp -c` — APFS clonefile, so the
 *     copy shares blocks with the original and costs ~no disk or time;
 *  2. the recipe's install then only reconciles the difference (a no-op when
 *     the lockfile is the same, a few packages when it isn't).
 * An install counts as finished only when `recipe.installedMarker` exists
 * (yarn writes `.yarn-integrity` last); a half-finished one is wiped first.
 * Refuses to start below `minFreeBytes` so it can't fill the disk.
 *
 * @returns "ready" (already installed), "cloned" (reused a sibling) or "installed" (from scratch)
 */
export interface InstallOptions {
  /** Refuse below this much free space. Default: 4 GB when copying from a donor, 8 GB from scratch. */
  minFreeBytes?: number;
  /** Copy node_modules from this installed worktree instead of searching siblings. */
  donor?: string;
  timeoutMs?: number;
}

/** Best donor among `worktree`'s siblings: same lockfile first, else any installed one. */
async function findDonor(recipe: AppRecipe, worktree: string): Promise<string | undefined> {
  const siblingsDir = path.dirname(worktree);
  const lock = await fileHash(path.join(worktree, recipe.lockfile));
  const installed = (await readdir(siblingsDir))
    .map((n) => path.join(siblingsDir, n))
    .filter((p) => p !== worktree && existsSync(path.join(p, recipe.installedMarker)));
  const hashes = await Promise.all(installed.map((p) => fileHash(path.join(p, recipe.lockfile))));
  return installed[hashes.findIndex((h) => h === lock)] ?? installed[0];
}

export async function ensureInstalled(
  recipe: AppRecipe,
  worktree: string,
  opts: InstallOptions = {}
): Promise<"ready" | "cloned" | "installed"> {
  if (existsSync(path.join(worktree, recipe.installedMarker))) return "ready";

  const explicit = opts.donor && existsSync(path.join(opts.donor, recipe.installedMarker)) ? opts.donor : undefined;
  const donor = explicit ?? (await findDonor(recipe, worktree));

  const minFreeBytes = opts.minFreeBytes ?? (donor ? 4 : 8) * 1024 ** 3;
  const fs = await statfs(worktree);
  const free = fs.bavail * fs.bsize;
  if (free < minFreeBytes) {
    throw new Error(`only ${(free / 1024 ** 3).toFixed(1)} GB free — need ${(minFreeBytes / 1024 ** 3).toFixed(0)} GB to install the app`);
  }

  // Wipe a half-finished install (no marker) so it can't be mistaken for a good one.
  for (const dir of await nodeModulesDirs(worktree)) await rm(path.join(worktree, dir), { recursive: true, force: true });

  if (donor) {
    for (const dir of await nodeModulesDirs(donor)) {
      if (!existsSync(path.join(worktree, path.dirname(dir)))) continue; // workspace package missing here
      await run("cp", cloneDirArgs(process.platform, path.join(donor, dir), path.join(worktree, dir)), worktree, 10 * 60_000);
    }
  }
  // HUSKY=0: the repo's `prepare` script would otherwise write git hooks config into the shared clone.
  await run(recipe.install.cmd, recipe.install.args, worktree, opts.timeoutMs ?? 15 * 60_000, { HUSKY: "0" });
  return donor ? "cloned" : "installed";
}

/**
 * `cp` arguments to copy an installed node_modules directory, cheaply where the
 * filesystem allows it. macOS: `-c` = APFS clone. Linux (the deploy VM): GNU cp has no
 * `-c` — `-a` keeps symlinks (.bin) intact, `--reflink=auto` clones on btrfs/xfs and
 * silently falls back to a plain copy elsewhere.
 */
export function cloneDirArgs(platform: NodeJS.Platform, from: string, to: string): string[] {
  return platform === "darwin" ? ["-cR", from, to] : ["-a", "--reflink=auto", from, to];
}

export interface AppServer {
  port: number;
  url: string;
  stop(): Promise<void>;
}

async function waitForHttp(url: string, child: ChildProcess, timeoutMs: number, tail: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const how = child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
      throw new Error(`dev server exited early (${how})${tail() ? `: ${tail()}` : ""}`);
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}${tail() ? `: ${tail()}` : ""}`);
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal); // negative pid = the whole process group
  } catch {
    /* already gone */
  }
}

export async function startApp(recipe: AppRecipe, worktree: string, timeoutMs = 180_000): Promise<AppServer> {
  const port = await freePort();
  const { cmd, args, env } = recipe.start(port);
  const child = spawn(cmd, args, { cwd: worktree, env: scrubbedEnv(env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  // Keep the tail of the dev server's output: "exited early (code 1)" alone is undiagnosable.
  let out = "";
  const keep = (d: Buffer) => (out = (out + d).slice(-1500));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const tail = () => out.trim().split("\n").slice(-6).join(" | ").slice(-500);
  // An unhandled 'error' (ENOENT, EAGAIN) would crash the whole API process.
  let spawnError: Error | undefined;
  child.on("error", (err) => (spawnError = err));

  const url = `http://127.0.0.1:${port}/`;
  const stop = async (): Promise<void> => {
    killGroup(child, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    killGroup(child, "SIGKILL");
  };
  try {
    await Promise.race([
      waitForHttp(url, child, timeoutMs, tail),
      new Promise<never>((_, reject) => {
        const t = setInterval(() => {
          if (spawnError) {
            clearInterval(t);
            reject(new Error(`could not start ${cmd}: ${spawnError.message}`));
          }
        }, 200);
        t.unref();
      }),
    ]);
  } catch (err) {
    await stop();
    throw err;
  }
  return { port, url, stop };
}

/**
 * Load the app once, the way a user would, before anything (including paid Bob time)
 * depends on it. A dev server answers `GET /` long before it has pre-bundled its
 * dependencies: on a cold start the first real navigation can take a minute and trigger
 * a full reload, which used to eat a paid run's few script attempts. Fails fast, for $0.
 */
export async function warmUp(
  url: string,
  opts: { readySelector?: string; timeoutMs?: number } = {}
): Promise<{ ms: number }> {
  const timeout = opts.timeoutMs ?? 120_000;
  const started = Date.now();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const settle = async (): Promise<void> => {
      if (opts.readySelector) await page.waitForSelector(opts.readySelector, { timeout });
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    };
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await settle();
    await page.reload({ waitUntil: "domcontentloaded", timeout });
    await settle();
  } catch (err) {
    const first = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    throw new Error(`warm-up failed for ${url}: ${first.slice(0, 200)}`);
  } finally {
    await browser.close().catch(() => {});
  }
  return { ms: Date.now() - started };
}
