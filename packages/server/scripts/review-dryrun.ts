/**
 * review-dryrun.ts — show where every quoted code line of a walkthrough would land on
 * the demo PR (line comment vs general comment), without posting anything.
 *
 *   pnpm --filter @pr-walkthrough/server review:dryrun excalidraw excalidraw 10295
 */
import "../src/env.js";
import { loadWalkthrough } from "../src/storage.js";
import { resolveTarget, resolveAnchor } from "../src/github/review.js";

const [owner, repo, number] = process.argv.slice(2);
const wt = await loadWalkthrough(owner, repo, parseInt(number, 10));
if (!wt) throw new Error(`No walkthrough for ${owner}/${repo}#${number}`);
const target = await resolveTarget(wt);
if ("disabled" in target) throw new Error(`Posting is off: ${target.disabled}`);
console.log(`target ${target.repo}#${target.number}`);

for (const step of wt.steps) {
  for (const beat of step.beats) {
    for (const block of beat.code ?? []) {
      for (let i = 0; i < block.lines.length; i++) {
        if (block.lines[i].kind === "elided") continue;
        const r = await resolveAnchor(target, { file: block.file, revision: block.revision, lines: block.lines, index: i });
        const where = r.line ? `${r.side} L${r.line}` : "NOT FOUND";
        console.log(`${step.id} ${block.file.split("/").pop()} [${block.lines[i].kind}] ${where} ${r.inDiff ? "line-comment" : "general"}  ${block.lines[i].text.trim().slice(0, 50)}`);
      }
    }
  }
}
