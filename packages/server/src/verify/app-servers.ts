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
import { existsSync } from "node:fs";
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

export async function ensureInstalled(recipe: AppRecipe, worktree: string): Promise<boolean> {
  if (existsSync(path.join(worktree, recipe.installedMarker))) return false;
  await run(recipe.install.cmd, recipe.install.args, worktree, 15 * 60_000);
  return true;
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
