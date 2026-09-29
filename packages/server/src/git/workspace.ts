/**
 * workspace.ts — clone/fetch a git repo into a local cache directory and
 * expose stable helpers to read file contents and produce diffs.
 *
 * Layout: `<cacheDir>/<owner>__<repo>` is a single shared blobless clone (the
 * "main" checkout, used only as an object store — never checked out at a
 * PR's head itself). Each PR gets its own `git worktree` at
 * `<cacheDir>/<owner>__<repo>/wt/<headSha>`, so multiple PRs on the same repo
 * (e.g. two Bob Shell runs analysing different PRs concurrently) never step
 * on each other's working tree, and each `RepoWorkspace.repoPath` is stable
 * for the lifetime of that PR's analysis.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile as fsReadFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const DEFAULT_CACHE_DIR =
  process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";

/** Run a git command inside a given working directory. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024, // 64 MB — large diffs are fine
  });
  return stdout;
}

/**
 * Resolve the shared `.git` directory for a path that may be a linked
 * worktree (whose `.git` is a *file* pointing at `<main>/.git/worktrees/…`,
 * not a directory). Files that must be shared across all worktrees of a repo
 * — like `info/exclude` — live under this common dir, not under `repoPath`.
 */
export async function gitCommonDir(repoPath: string): Promise<string> {
  const dir = (await git(repoPath, ["rev-parse", "--git-common-dir"])).trim();
  return path.isAbsolute(dir) ? dir : path.resolve(repoPath, dir);
}

/**
 * Serialise the clone/fetch/worktree-add sequence for one repo across
 * concurrent callers (e.g. two PRs on the same repo analysed at once) using
 * a directory as a simple cross-process lock (`mkdir` is atomic on POSIX).
 * A stale lock (from a crashed process) times out after 60s — remove the
 * `<mainPath>.lock` directory by hand if that ever happens.
 */
async function withRepoLock<T>(mainPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${mainPath}.lock`;
  // A fresh cache volume has no parent directory yet; the lock's own mkdir must stay
  // non-recursive (that is what makes it atomic), so create the parent first.
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for repo lock: ${lockPath} (remove it by hand if stale)`);
      }
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lockPath).catch(() => {});
  }
}

export interface RepoWorkspace {
  repoPath: string;
  baseSha: string;
  headSha: string;
  /**
   * Return the contents of `filePath` at the given revision.
   *  - "base"  → `git show {baseSha}:{filePath}`
   *  - "head"  → read the checked-out file from the working tree
   */
  readFile(filePath: string, revision: "base" | "head"): Promise<string>;
  /**
   * Return the full unified diff output of `git diff {baseSha}...{headSha}`.
   * Three-dot syntax: shows what changed on the head branch since it diverged
   * from base (i.e. the PR diff).
   */
  diff(): Promise<string>;
}

/**
 * Prepare a local git worktree for the given repo/SHAs.
 *
 * - If the repo has not been cloned yet, clones it (blobless: --filter=blob:none --no-checkout).
 *   This "main" clone is never checked out itself — it exists only as the shared object store.
 * - Fetches `pull/{prNumber}/head` and `baseSha` explicitly so fork PRs work.
 * - Adds (or reuses) a `git worktree` at `<repoPath>/wt/<headSha>`, detached at `headSha`.
 *   Reusing the same headSha's worktree across calls is a no-op past the first checkout.
 *
 * @param repoUrl  Full clone URL, e.g. "https://github.com/outline/outline"
 * @param headSha  The SHA of the PR head commit.
 * @param baseSha  The SHA of the PR base commit.
 * @param prNumber The PR number — used to fetch the fork head ref.
 * @param cacheDir Optional override for the cache directory root.
 */
export async function prepareWorkspace(
  repoUrl: string,
  headSha: string,
  baseSha: string,
  prNumber: number,
  cacheDir?: string
): Promise<RepoWorkspace> {
  const root = cacheDir ?? DEFAULT_CACHE_DIR;

  // Derive a stable folder name from the last two path segments of the URL
  // e.g. "https://github.com/outline/outline" → "outline__outline"
  const urlParts = repoUrl.replace(/\.git$/, "").split("/");
  const repoName = urlParts.slice(-2).join("__");
  const mainPath = path.join(root, repoName);
  const repoPath = path.join(mainPath, "wt", headSha);

  await withRepoLock(mainPath, async () => {
    if (!existsSync(path.join(mainPath, ".git"))) {
      // Blobless clone: fast for large repos; --no-checkout avoids materialising
      // a working tree we never use directly (PRs get their own worktree below).
      await mkdir(root, { recursive: true });
      await execFileAsync(
        "git",
        ["clone", "--quiet", "--filter=blob:none", "--no-checkout", repoUrl, mainPath],
        { maxBuffer: 64 * 1024 * 1024 }
      );
    }

    // Fork PR heads are not on any upstream branch — fetch via refs/pull/N/head.
    // Also fetch baseSha explicitly so it is available for `git diff` and `git show`.
    await git(mainPath, ["fetch", "--quiet", "origin", `pull/${prNumber}/head`, baseSha]);

    if (existsSync(path.join(repoPath, ".git"))) {
      // Worktree already exists (from an earlier run analysing this same PR) —
      // just make sure it's sitting at the right commit.
      await git(repoPath, ["checkout", "--detach", "--quiet", "--force", headSha]);
    } else {
      await mkdir(path.join(mainPath, "wt"), { recursive: true });
      await git(mainPath, ["worktree", "add", "--detach", "--quiet", repoPath, headSha]);
    }
  });

  const workspace: RepoWorkspace = {
    repoPath,
    baseSha,
    headSha,

    async readFile(filePath: string, revision: "base" | "head"): Promise<string> {
      if (revision === "base") {
        return git(repoPath, ["show", `${baseSha}:${filePath}`]);
      }
      // "head" — read from the checked-out working tree
      return fsReadFile(path.join(repoPath, filePath), "utf-8");
    },

    async diff(): Promise<string> {
      return git(repoPath, ["diff", `${baseSha}...${headSha}`]);
    },
  };

  return workspace;
}

/**
 * Add (or reuse) a detached worktree at `<mainPath>/wt/<sha>` for any commit
 * already fetched into the shared clone — e.g. a PR's BASE, which the
 * screenshot verifier needs next to the analyzer's HEAD worktree.
 */
export async function ensureWorktree(mainPath: string, sha: string): Promise<string> {
  const dest = path.join(mainPath, "wt", sha);
  await withRepoLock(mainPath, async () => {
    if (existsSync(path.join(dest, ".git"))) return;
    await git(mainPath, ["cat-file", "-e", `${sha}^{commit}`]).catch(() =>
      git(mainPath, ["fetch", "--quiet", "origin", sha])
    );
    await mkdir(path.join(mainPath, "wt"), { recursive: true });
    await git(mainPath, ["worktree", "add", "--detach", "--quiet", dest, sha]);
  });
  return dest;
}

/**
 * Free disk before a run: every analysed PR leaves two worktrees behind (BASE and HEAD), each with
 * its own ~1.5 GB `node_modules`, and nothing ever removed them — a 47 GB VM fills in a handful
 * of PRs. Keeps the worktrees named in `keepShas` plus the `keepRecent` most recently touched
 * others (so re-running the previous PR stays cheap); removes the rest, and any ablation scratch
 * directory (`abl-*`) left behind by a crashed run.
 *
 * @returns the names of the removed worktree directories
 */
export async function pruneWorktrees(
  mainPath: string,
  keepShas: string[],
  keepRecent = 2
): Promise<string[]> {
  const wtRoot = path.join(mainPath, "wt");
  if (!existsSync(wtRoot)) return [];
  const removed: string[] = [];
  await withRepoLock(mainPath, async () => {
    const entries = (await readdir(wtRoot, { withFileTypes: true })).filter((e) => e.isDirectory());
    const info = await Promise.all(
      entries.map(async (e) => ({ name: e.name, mtime: (await stat(path.join(wtRoot, e.name))).mtimeMs }))
    );
    const keep = new Set(keepShas);
    const now = Date.now();
    const scratch = info.filter((i) => i.name.startsWith("abl-") && now - i.mtime > 60 * 60_000);
    const others = info
      .filter((i) => !i.name.startsWith("abl-") && !keep.has(i.name))
      .sort((a, b) => b.mtime - a.mtime);
    const drop = [...scratch, ...others.slice(keepRecent)];
    for (const d of drop) {
      const dir = path.join(wtRoot, d.name);
      await git(mainPath, ["worktree", "remove", "--force", dir]).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      removed.push(d.name);
    }
    if (drop.length > 0) await git(mainPath, ["worktree", "prune"]).catch(() => {});
  });
  return removed;
}
