/**
 * annotate-lines.ts — backfill line numbers + change markers on an already
 * generated walkthrough JSON, and report (never silently fix) any stitched
 * code found (validation/line-numbers.ts). $0: only needs the repo already
 * cloned in the git cache — no Bob call.
 *
 *   pnpm --filter @pr-walkthrough/server annotate-lines excalidraw/excalidraw#10943
 *   … annotate-lines excalidraw/excalidraw#10943 --dry-run   # report only, don't save
 */
import "../src/env.js";

import { loadWalkthrough, saveWalkthrough } from "../src/storage.js";
import { prepareWorkspace } from "../src/git/workspace.js";
import { annotateLines } from "../src/validation/line-numbers.js";

const CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";

const spec = process.argv[2] ?? "";
const dryRun = process.argv.includes("--dry-run");
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(spec);
if (!m) throw new Error(`Usage: annotate-lines owner/repo#number [--dry-run] (got "${spec}")`);
const [, owner, repo, numStr] = m;
const number = parseInt(numStr, 10);

const wt = await loadWalkthrough(owner, repo, number);
if (!wt) throw new Error(`No cached walkthrough for ${spec}`);
if (!wt.pr.baseSha || !wt.pr.headSha) throw new Error(`${spec}: walkthrough has no base/head SHA`);

const workspace = await prepareWorkspace(`https://github.com/${owner}/${repo}`, wt.pr.headSha, wt.pr.baseSha, number, CACHE_DIR);
const diff = await workspace.diff();

const before = JSON.stringify(wt.steps); // cheap "did anything change" check for the summary line
const errors = await annotateLines(wt, workspace, diff);
const changed = JSON.stringify(wt.steps) !== before;

let added = 0, removed = 0, numbered = 0;
for (const step of wt.steps) {
  for (const beat of step.beats) {
    for (const block of beat.code ?? []) {
      for (const line of block.lines) {
        if (line.n !== undefined) numbered++;
        if (line.change === "added") added++;
        if (line.change === "removed") removed++;
      }
    }
  }
}

console.log(`${spec}: ${numbered} lines numbered, ${added} marked added, ${removed} marked removed`);
if (errors.length > 0) {
  console.log(`\n${errors.length} stitched-code issue(s) — NOT auto-fixed, needs a human to add "elided" or requote:`);
  for (const e of errors) console.log(`  - ${e}`);
} else {
  console.log("no stitching issues");
}

if (dryRun) {
  console.log("\n--dry-run: not saved");
} else if (changed) {
  await saveWalkthrough(wt);
  console.log(`saved ${spec}`);
} else {
  console.log("no change to save");
}
