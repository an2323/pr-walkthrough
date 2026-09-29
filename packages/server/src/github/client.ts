/**
 * github/client.ts — minimal GitHub REST API client (no Octokit dependency).
 *
 * Uses globalThis.fetch (Node 18+). GITHUB_TOKEN is read from the environment.
 */

import type { PullRequestMeta } from "@pr-walkthrough/shared";

const GITHUB_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function githubGet(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...authHeaders(),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} for ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** "owner/repo" this repository was forked from, or undefined when it isn't a fork. */
export async function fetchForkParent(owner: string, repo: string): Promise<string | undefined> {
  const r = (await githubGet(`${GITHUB_API}/repos/${owner}/${repo}`)) as { fork?: boolean; parent?: { full_name?: string } };
  return r.fork ? r.parent?.full_name : undefined;
}

interface GHPullResponse {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  user: { login: string };
  merged_at: string | null;
  base: { sha: string };
  head: { sha: string };
  changed_files: number;
  additions: number;
  deletions: number;
}

interface GHCommit {
  commit: { message: string };
}

/**
 * Fetch PR metadata and commit titles from the GitHub REST API.
 */
export async function fetchPRMeta(
  owner: string,
  repo: string,
  number: number
): Promise<PullRequestMeta> {
  const [prData, commitsData] = await Promise.all([
    githubGet(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`) as Promise<GHPullResponse>,
    githubGet(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/commits`) as Promise<GHCommit[]>,
  ]);

  const commitTitles = commitsData.map((c) => c.commit.message.split("\n")[0]);

  return {
    repo: `${owner}/${repo}`,
    number: prData.number,
    title: prData.title,
    url: prData.html_url,
    author: prData.user.login,
    mergedAt: prData.merged_at ?? undefined,
    baseSha: prData.base.sha,
    headSha: prData.head.sha,
    filesChanged: prData.changed_files,
    additions: prData.additions,
    deletions: prData.deletions,
    commitTitles,
    body: prData.body ?? undefined,
  };
}

/**
 * Parse a GitHub PR URL into { owner, repo, number }.
 * Accepts: https://github.com/owner/repo/pull/123
 */
export function parsePRUrl(prUrl: string): { owner: string; repo: string; number: number } {
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error(`Cannot parse PR URL: ${prUrl}`);
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}
