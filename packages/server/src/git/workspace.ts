/**
 * workspace.ts — clone/fetch a git repo into a local cache directory and
 * expose stable helpers to read file contents and produce diffs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile as fsReadFile } from "node:fs/promises";
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
 * Prepare a local git workspace for the given repo/SHAs.
 *
 * - If the repo has not been cloned yet, clones it.
 * - If it already exists, runs `git fetch --quiet`.
 * - Checks out `headSha` as a detached HEAD.
 *
 * @param repoUrl  Full clone URL, e.g. "https://github.com/outline/outline"
 * @param headSha  The SHA of the PR head commit.
 * @param baseSha  The SHA of the PR base commit.
 * @param cacheDir Optional override for the cache directory root.
 */
export async function prepareWorkspace(
  repoUrl: string,
  headSha: string,
  baseSha: string,
  cacheDir?: string
): Promise<RepoWorkspace> {
  const root = cacheDir ?? DEFAULT_CACHE_DIR;

  // Derive a stable folder name from the last two path segments of the URL
  // e.g. "https://github.com/outline/outline" → "outline__outline"
  const urlParts = repoUrl.replace(/\.git$/, "").split("/");
  const repoName = urlParts.slice(-2).join("__");
  const repoPath = path.join(root, repoName);

  if (existsSync(path.join(repoPath, ".git"))) {
    // Already cloned — fetch latest objects quietly
    await git(repoPath, ["fetch", "--quiet", "--no-tags"]);
  } else {
    // Clone into the cache directory (bare clone not used so we can read files)
    await execFileAsync("git", ["clone", "--quiet", repoUrl, repoPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  // Detach HEAD at headSha so the working tree reflects the PR head
  await git(repoPath, ["checkout", "--detach", "--quiet", headSha]);

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
