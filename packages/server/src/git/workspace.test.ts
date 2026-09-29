import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureWorktree, pruneWorktrees } from "./workspace.js";

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

describe("pruneWorktrees", () => {
  let dir: string;
  let main: string;
  const shas: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "prune-"));
    main = path.join(dir, "owner__repo");
    mkdirSync(main);
    g(main, "init", "-q");
    g(main, "config", "user.email", "t@t");
    g(main, "config", "user.name", "t");
    for (let i = 0; i < 5; i++) {
      g(main, "commit", "-q", "--allow-empty", "-m", `c${i}`);
      shas.push(g(main, "rev-parse", "HEAD"));
    }
    // Age the worktrees oldest → newest so "most recently touched" is well defined.
    for (const [i, sha] of shas.entries()) {
      const wt = await ensureWorktree(main, sha);
      const t = new Date(Date.now() - (shas.length - i) * 60_000);
      utimesSync(wt, t, t);
    }
  });

  afterEach(() => {
    shas.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  const exists = (sha: string) => existsSync(path.join(main, "wt", sha));

  it("keeps the named worktrees plus the most recent others, removes the rest", async () => {
    const removed = await pruneWorktrees(main, [shas[4]], 2);
    expect(removed.sort()).toEqual([shas[0], shas[1]].sort());
    expect(exists(shas[4])).toBe(true); // named
    expect(exists(shas[3])).toBe(true); // most recent other
    expect(exists(shas[2])).toBe(true); // second most recent other
    expect(exists(shas[1])).toBe(false);
    expect(exists(shas[0])).toBe(false);
    expect(g(main, "worktree", "list")).not.toContain(shas[0]);
  });

  it("never removes a named worktree even when it is the oldest", async () => {
    await pruneWorktrees(main, [shas[0]], 0);
    expect(exists(shas[0])).toBe(true);
    for (const sha of shas.slice(1)) expect(exists(sha)).toBe(false);
  });

  it("clears stale ablation scratch dirs but leaves fresh ones (a run may be using them)", async () => {
    const stale = path.join(main, "wt", "abl-old");
    const fresh = path.join(main, "wt", "abl-new");
    mkdirSync(stale);
    mkdirSync(fresh);
    const old = new Date(Date.now() - 3 * 3600_000);
    utimesSync(stale, old, old);
    await pruneWorktrees(main, shas, 10);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("is a no-op when there is nothing to prune", async () => {
    expect(await pruneWorktrees(path.join(dir, "missing"), [], 2)).toEqual([]);
  });
});
