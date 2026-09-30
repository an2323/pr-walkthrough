/**
 * preview.ts — what will happen if this PR is analysed, before anyone presses the button (GET /api/preview).
 * Free to call: a finished walkthrough is answered from our own store; otherwise one GitHub lookup
 * (cached a few minutes). It never starts Bob and never spends anything.
 */

import type { Walkthrough } from "@pr-walkthrough/shared";

import { shotsNotPlannedReason } from "./progress-events.js";

export interface PrPreview {
  owner: string;
  repo: string;
  number: number;
  /** A finished walkthrough exists — it opens instantly and free. */
  analysed: boolean;
  title?: string;
  additions?: number;
  deletions?: number;
  files?: number;
  /** Would the app be started for before/after screenshots? `reason` says why not, in a sentence. */
  screenshots: { available: boolean; reason?: string };
  /** Plain message when the PR is over the size caps (it would be refused when analysing). */
  tooBig?: string;
}

export interface PreviewDeps {
  parsePRUrl(url: string): { owner: string; repo: string; number: number };
  loadWalkthrough(owner: string, repo: string, number: number): Promise<Walkthrough | null>;
  fetchPRMeta(owner: string, repo: string, number: number): Promise<{ title: string; additions: number; deletions: number; filesChanged: number }>;
  /** True when the app of this repo (or of the repo it is a fork of) can be started. */
  canVerify(owner: string, repo: string): Promise<boolean>;
  now?(): number;
}

export class PreviewError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: PrPreview }>();

export function clearPreviewCache(): void {
  cache.clear();
}

function screenshotsFor(available: boolean, owner: string, repo: string): PrPreview["screenshots"] {
  const reason = shotsNotPlannedReason(available, process.env.VERIFY_SHOTS === "0", `${owner}/${repo}`);
  return reason === undefined ? { available: true } : { available: false, reason };
}

/** Same caps the analyze guard applies (MAX_PR_FILES, MAX_PR_DIFF), as a sentence. */
function sizeProblem(files: number, changed: number): string | undefined {
  const maxFiles = Number(process.env.MAX_PR_FILES ?? 80);
  const maxDiff = Number(process.env.MAX_PR_DIFF ?? 2000);
  if (maxFiles > 0 && files > maxFiles) return `This PR changes ${files} files; analysis is limited to ${maxFiles}.`;
  if (maxDiff > 0 && changed > maxDiff) return `This PR changes ${changed} lines; analysis is limited to ${maxDiff}.`;
  return undefined;
}

export async function buildPreview(rawUrl: string, deps: PreviewDeps): Promise<PrPreview> {
  let parsed: { owner: string; repo: string; number: number };
  try {
    parsed = deps.parsePRUrl(rawUrl);
  } catch {
    throw new PreviewError("That doesn't look like a pull request link", 400);
  }
  const { owner, repo, number } = parsed;
  const key = `${owner}/${repo}#${number}`;
  const now = deps.now?.() ?? Date.now();

  const done = await deps.loadWalkthrough(owner, repo, number);
  if (done) {
    return {
      owner, repo, number, analysed: true,
      title: done.plain?.title ?? done.pr.title,
      screenshots: screenshotsFor(await deps.canVerify(owner, repo), owner, repo),
    };
  }

  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  let meta: Awaited<ReturnType<PreviewDeps["fetchPRMeta"]>>;
  try {
    meta = await deps.fetchPRMeta(owner, repo, number);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b404\b|not found/i.test(msg)) throw new PreviewError("We can't see that pull request — is it public, and is the number right?", 404);
    throw new PreviewError("GitHub didn't answer just now — try again in a moment", 502);
  }
  const value: PrPreview = {
    owner, repo, number, analysed: false,
    title: meta.title,
    additions: meta.additions,
    deletions: meta.deletions,
    files: meta.filesChanged,
    screenshots: screenshotsFor(await deps.canVerify(owner, repo), owner, repo),
    ...(sizeProblem(meta.filesChanged, meta.additions + meta.deletions) ? { tooBig: sizeProblem(meta.filesChanged, meta.additions + meta.deletions)! } : {}),
  };
  cache.set(key, { at: now, value });
  return value;
}
