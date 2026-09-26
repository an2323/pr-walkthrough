/**
 * cached.ts — CachedAnalyzer reads a pre-generated walkthrough JSON from disk.
 *
 * Used in demo/CI mode (ANALYZER=cached) to serve stored results without calling Bob.
 * Reads from: data/walkthroughs/{owner}/{repo}/{number}.json  (relative to repo root).
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Analyzer, AnalyzerInput, WalkthroughDraft } from "./interface.js";

// Repo root = 4 levels up from packages/server/src/analyzer/
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export class CachedAnalyzer implements Analyzer {
  async analyze(input: AnalyzerInput): Promise<WalkthroughDraft> {
    const { owner, repo, number } = input.pr as unknown as {
      owner: string;
      repo: string;
      number: number;
    };

    // Support both "owner/repo" (PullRequestMeta.repo) and separate owner/repo fields.
    const [resolvedOwner, resolvedRepo] = owner
      ? [owner, repo]
      : (input.pr.repo as string).split("/");
    const resolvedNumber = number ?? (input.pr as unknown as { number: number }).number;

    const filePath = path.join(
      ROOT,
      "data/walkthroughs",
      resolvedOwner,
      resolvedRepo,
      `${resolvedNumber}.json`
    );

    if (!existsSync(filePath)) {
      throw new Error(
        `CachedAnalyzer: no cached walkthrough at ${filePath}. ` +
          `Run the full analyzer first or copy the golden JSON there.`
      );
    }

    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as WalkthroughDraft;
  }
}
