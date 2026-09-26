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

/** PATH/HOME/locale/tmp only — never our secrets. */
export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "NVM_DIR", "COREPACK_HOME"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

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

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: scrubbedEnv(), stdio: ["ignore", "ignore", "pipe"], timeout: timeoutMs });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.trim().slice(-500)}`))
    );
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
export async function ensureInstalled(
  recipe: AppRecipe,
  worktree: string,
  minFreeBytes = 3 * 1024 ** 3
): Promise<"ready" | "cloned" | "installed"> {
  if (existsSync(path.join(worktree, recipe.installedMarker))) return "ready";

  const fs = await statfs(worktree);
  const free = fs.bavail * fs.bsize;
  if (free < minFreeBytes) {
    throw new Error(`only ${(free / 1024 ** 3).toFixed(1)} GB free — need ${(minFreeBytes / 1024 ** 3).toFixed(0)} GB to install the app`);
  }

  // Wipe a half-finished install (no marker) so it can't be mistaken for a good one.
  for (const dir of await nodeModulesDirs(worktree)) await rm(path.join(worktree, dir), { recursive: true, force: true });

  // Best donor: an installed sibling with the same lockfile, else any installed sibling.
  const siblingsDir = path.dirname(worktree);
  const lock = await fileHash(path.join(worktree, recipe.lockfile));
  const installed = (await readdir(siblingsDir))
    .map((n) => path.join(siblingsDir, n))
    .filter((p) => p !== worktree && existsSync(path.join(p, recipe.installedMarker)));
  const hashes = await Promise.all(installed.map((p) => fileHash(path.join(p, recipe.lockfile))));
  const donor = installed[hashes.findIndex((h) => h === lock)] ?? installed[0];

  if (donor) {
    for (const dir of await nodeModulesDirs(donor)) {
      if (!existsSync(path.join(worktree, path.dirname(dir)))) continue; // workspace package missing here
      await run("cp", ["-cR", path.join(donor, dir), path.join(worktree, dir)], worktree, 10 * 60_000);
    }
  }
  await run(recipe.install.cmd, recipe.install.args, worktree, 15 * 60_000);
  return donor ? "cloned" : "installed";
}

export interface AppServer {
  port: number;
  url: string;
  stop(): Promise<void>;
}

async function waitForHttp(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev server exited early (code ${child.exitCode})`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal); // negative pid = the whole process group
  } catch {
    /* already gone */
  }
}

export async function startApp(recipe: AppRecipe, worktree: string): Promise<AppServer> {
  const port = await freePort();
  const { cmd, args, env } = recipe.start(port);
  const child = spawn(cmd, args, { cwd: worktree, env: scrubbedEnv(env), detached: true, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}/`;
  const stop = async (): Promise<void> => {
    killGroup(child, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    killGroup(child, "SIGKILL");
  };
  try {
    await waitForHttp(url, child, 180_000);
  } catch (err) {
    await stop();
    throw err;
  }
  return { port, url, stop };
}
