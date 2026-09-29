/**
 * check-run.ts — acceptance check of a finished walkthrough ON THE SITE, as a reader gets it.
 *
 *   pnpm exec tsx scripts/check-run.ts --site https://host --pr excalidraw/excalidraw#10295 [--rehearsal] [--audio]
 *
 * Runs the rubric (src/validation/run-report.ts) on the served JSON, then checks over HTTP that
 * every frame it references loads, and (with --audio) that every narration sentence has audio —
 * fetching them also generates any that are missing (TTS_GENERATE=1), so a passing --audio check
 * leaves the walkthrough fully voiced. Exit code 1 on any FAIL.
 */

import type { Walkthrough } from "@pr-walkthrough/shared";

import { formatReport, reportFailed, reportWalkthrough, type ReportLine } from "../src/validation/run-report.js";
import { pngDimensions } from "../src/shots/frames.js";
import { OUTRO_NARRATION, OUTRO_STEP_ID, splitSentences } from "../src/tts/elevenlabs.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const site = (arg("--site") ?? "http://localhost:3000").replace(/\/$/, "");
const prArg = arg("--pr") ?? "excalidraw/excalidraw#10295";
const rehearsal = process.argv.includes("--rehearsal");
const audio = process.argv.includes("--audio");
const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(prArg);
if (!m) throw new Error(`--pr must look like owner/repo#123, got ${prArg}`);
const [, owner, repo, number] = m;

const res = await fetch(`${site}/api/walkthroughs/${owner}/${repo}/${number}${rehearsal ? "?rehearsal=1" : ""}`);
if (!res.ok) {
  console.log(`FAIL  walkthrough served — HTTP ${res.status}`);
  process.exit(1);
}
const wt = (await res.json()) as Walkthrough;
const lines: ReportLine[] = reportWalkthrough(wt);

// Every frame the viewer will request.
const frames = new Set<string>();
if (wt.shots) for (const side of [wt.shots.before, wt.shots.after]) if (side?.src) frames.add(side.src);
for (const s of wt.steps) {
  if (s.visual?.type === "symptoms") for (const i of s.visual.items) if (typeof i !== "string" && i.src) frames.add(i.src);
}
const broken: string[] = [];
const badLook: string[] = [];
for (const src of frames) {
  const r = await fetch(`${site}/data/shots/${owner}/${repo}/${number}/${src}`, { redirect: "follow" });
  const type = r.headers.get("content-type") ?? "";
  if (!r.ok || !type.startsWith("image/")) broken.push(`${src} (${r.status} ${type})`);
  else {
    // How the picture will look to the reader: big enough to read, and not a sliver or a strip.
    const d = pngDimensions(Buffer.from(await r.arrayBuffer()));
    if (d && d.width < 300) badLook.push(`${src}: only ${d.width}px wide`);
    if (d && (d.width / d.height > 4 || d.width / d.height < 0.25)) badLook.push(`${src}: ${d.width}×${d.height} is a strip`);
  }
}
lines.push({ ok: broken.length === 0, level: "fail", check: `all ${frames.size} frame(s) load`, ...(broken.length ? { detail: broken.join(", ") } : {}) });
lines.push({ ok: badLook.length === 0, level: "fail", check: "frames are readable (size and proportions)", ...(badLook.length ? { detail: badLook.join("; ") } : {}) });

if (audio) {
  const sentences: { step: string; n: number }[] = [];
  for (const s of wt.steps) splitSentences(s.narration ?? "").forEach((_, n) => sentences.push({ step: s.id, n }));
  if ((wt.graph?.nodes?.length ?? 0) > 0) splitSentences(OUTRO_NARRATION).forEach((_, n) => sentences.push({ step: OUTRO_STEP_ID, n }));
  const missing: string[] = [];
  for (const { step, n } of sentences) {
    const r = await fetch(`${site}/api/audio/${owner}/${repo}/${number}/${step}/${n}.mp3`, { redirect: "follow" });
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok || !/audio|mpeg|octet-stream/.test(type)) missing.push(`${step}/${n} (${r.status})`);
    await r.arrayBuffer().catch(() => undefined);
  }
  lines.push({
    ok: missing.length === 0,
    level: "fail",
    check: `all ${sentences.length} narration sentence(s) have audio`,
    ...(missing.length ? { detail: missing.slice(0, 8).join(", ") + (missing.length > 8 ? ` … +${missing.length - 8}` : "") } : {}),
  });
}

console.log(`${prArg}${rehearsal ? " (rehearsal)" : ""} — ${wt.steps.length} steps, ${frames.size} frame(s)`);
console.log(formatReport(lines));
const failed = reportFailed(lines);
console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);
