/**
 * storage.ts — read/write walkthrough JSON files under data/walkthroughs/.
 *
 * Path pattern: data/walkthroughs/{owner}/{repo}/{number}.json
 * relative to the workspace root (3 levels up from packages/server/src/).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Walkthrough } from "@pr-walkthrough/shared";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function walkthroughPath(owner: string, repo: string, number: number): string {
  return path.join(ROOT, "data/walkthroughs", owner, repo, `${number}.json`);
}

/**
 * Persist a completed walkthrough to disk.
 * @returns The absolute file path where it was written.
 */
export async function saveWalkthrough(wt: Walkthrough): Promise<string> {
  const [owner, repo] = wt.pr.repo.split("/");
  const filePath = walkthroughPath(owner, repo, wt.pr.number);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(wt, null, 2), "utf-8");
  return filePath;
}

/**
 * Load a walkthrough from disk. Returns null if the file does not exist.
 */
export async function loadWalkthrough(
  owner: string,
  repo: string,
  number: number
): Promise<Walkthrough | null> {
  const filePath = walkthroughPath(owner, repo, number);
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as Walkthrough;
}
