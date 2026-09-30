/**
 * guards.ts — refuse expensive / unsupported analyze requests before Bob runs.
 */

import { timingSafeEqual } from "node:crypto";

import { fetchPRMeta } from "../github/client.js";
import type { PullRequestMeta } from "@pr-walkthrough/shared";

const GITHUB_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class GuardError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = "GuardError";
  }
}

/** Paid runs allowed per rolling 24 h (ANALYZE_DAILY_LIMIT, default 5; 0 = no limit). */
export function dailyLimit(): number {
  return Number(process.env.ANALYZE_DAILY_LIMIT ?? 5);
}

/**
 * Admin key (env ACCESS_CODE). Ordinary analyses need no code — anyone may start one, within the daily limit and the
 * overall budget cap. The key guards the two things a visitor must never do: `force` (re-run and OVERWRITE a finished
 * walkthrough) and rehearsals (they occupy the machine). Unset = those two are refused.
 */
export function adminKeyOk(req: { body?: { accessCode?: unknown }; header(name: string): string | undefined }): boolean {
  const expected = process.env.ACCESS_CODE?.trim();
  if (!expected) return false;
  const got =
    (typeof req.body?.accessCode === "string" ? req.body.accessCode : undefined)?.trim() ||
    req.header("x-access-code")?.trim() ||
    "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function assertDailyLimit(usedLast24h: number): Promise<void> {
  const limit = dailyLimit();
  if (limit > 0 && usedLast24h >= limit) {
    throw new GuardError(`Daily limit reached (${limit} analyses per 24 h) — try again tomorrow`, 429);
  }
}

/**
 * Public repo + size caps. Call before spending Bobcoins.
 * Env: MAX_PR_FILES (default 80), MAX_PR_DIFF (additions+deletions, default 2000).
 */
export async function assertAnalyzablePr(
  owner: string,
  repo: string,
  number: number
): Promise<PullRequestMeta> {
  const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...authHeaders(),
    },
  });
  if (repoRes.status === 404) {
    throw new GuardError(`Repository ${owner}/${repo} not found or private`, 404);
  }
  if (!repoRes.ok) {
    const body = await repoRes.text().catch(() => "");
    throw new GuardError(`GitHub repo lookup failed (${repoRes.status}): ${body.slice(0, 200)}`, 502);
  }
  const repoJson = (await repoRes.json()) as { private?: boolean };
  if (repoJson.private) {
    throw new GuardError("Only public repositories are supported", 403);
  }

  const pr = await fetchPRMeta(owner, repo, number);
  const maxFiles = Number(process.env.MAX_PR_FILES ?? 80);
  const maxDiff = Number(process.env.MAX_PR_DIFF ?? 2000);
  if (pr.filesChanged > maxFiles) {
    throw new GuardError(
      `PR touches ${pr.filesChanged} files (max ${maxFiles}). Try a smaller PR.`,
      413
    );
  }
  const diffSize = pr.additions + pr.deletions;
  if (diffSize > maxDiff) {
    throw new GuardError(
      `PR diff is +${pr.additions}/−${pr.deletions} (max ${maxDiff} lines changed). Try a smaller PR.`,
      413
    );
  }
  return pr;
}
