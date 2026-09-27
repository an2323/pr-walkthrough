/**
 * annotate-shots.ts — redraw the annotated before/after images from walkthrough.shots.
 *
 *   pnpm --filter @pr-walkthrough/server annotate-shots excalidraw/excalidraw#10295
 *
 * Reads each side's `raw` screenshot + `highlights`, writes `src` with the boxes drawn in.
 * Run after editing highlight coordinates or labels in the walkthrough JSON.
 */
import "../src/env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWalkthrough } from "../src/storage.js";
import { annotateShot } from "../src/shots/annotate.js";
import { maybeCropRegion } from "../src/verify/highlights.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const spec = process.argv[2] ?? "excalidraw/excalidraw#10295";
const noCrop = process.argv.includes("--no-crop");
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(spec);
if (!m) throw new Error(`Expected owner/repo#number, got ${spec}`);
const [, owner, repo, numStr] = m;
const number = parseInt(numStr, 10);

const wt = await loadWalkthrough(owner, repo, number);
if (!wt?.shots) throw new Error(`${spec}: walkthrough has no shots`);

const dir = path.join(ROOT, "data/shots", owner, repo, String(number));
const crop = noCrop ? undefined : maybeCropRegion(wt.shots.before.highlights ?? [], wt.shots.after.highlights ?? []);
if (crop) console.log(`cropping to x=${crop.x.toFixed(2)} y=${crop.y.toFixed(2)} w=${crop.w.toFixed(2)} h=${crop.h.toFixed(2)} (pass --no-crop to disable)`);
for (const [side, tone] of [["before", "bad"], ["after", "good"]] as const) {
  const s = wt.shots[side];
  if (!s.raw) throw new Error(`${spec}: shots.${side}.raw is missing`);
  await annotateShot(path.join(dir, s.raw), path.join(dir, s.src), s.highlights ?? [], tone, crop);
  console.log(`wrote ${path.join(dir, s.src)}`);
}
