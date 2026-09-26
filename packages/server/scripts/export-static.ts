/**
 * export-static.ts — write the public demo's /data/ into a built viewer (ST6f).
 *
 *   VITE_STATIC=1 pnpm --filter @pr-walkthrough/web build
 *   pnpm --filter @pr-walkthrough/server export-static [outDir] [owner/repo#number ...]
 *
 * Copies walkthrough JSON, the recorded run (ndjson) and narration mp3s. Audio files are
 * stored as {stepId}-{n}-{hash}.mp3 where the hash covers the sentence text + voice id,
 * so only audio matching the CURRENT narration is exported (as {stepId}/{n}.mp3); stale
 * sentences are left out and the viewer falls back to Web Speech for them.
 *
 * Only Excalidraw (MIT) is allowed — Outline's licence is unverified.
 */
import "../src/env.js";
import { cp, mkdir, readdir, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWalkthrough } from "../src/storage.js";
import { splitSentences, sentenceHash } from "../src/tts/elevenlabs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ALLOWED_OWNERS = new Set(["excalidraw"]);
const DEFAULT_PRS = ["excalidraw/excalidraw#10295", "excalidraw/excalidraw#8340"];

const args = process.argv.slice(2);
const outDir = path.resolve(args[0] ?? path.join(ROOT, "packages/web/dist"));
const prs = args.length > 1 ? args.slice(1) : DEFAULT_PRS;
const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "";

if (!existsSync(path.join(outDir, "index.html"))) {
  throw new Error(`${outDir}/index.html not found — run VITE_STATIC=1 pnpm --filter @pr-walkthrough/web build first`);
}

for (const spec of prs) {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(spec);
  if (!m) throw new Error(`Expected owner/repo#number, got ${spec}`);
  const [, owner, repo, numStr] = m;
  if (!ALLOWED_OWNERS.has(owner)) throw new Error(`${spec}: only ${[...ALLOWED_OWNERS].join(", ")} PRs may be published`);
  const number = parseInt(numStr, 10);

  const wt = await loadWalkthrough(owner, repo, number);
  if (!wt) throw new Error(`No walkthrough for ${spec}`);
  const wtOut = path.join(outDir, "data/walkthroughs", owner, repo);
  await mkdir(wtOut, { recursive: true });
  await writeFile(path.join(wtOut, `${number}.json`), JSON.stringify(wt));

  const events = path.join(ROOT, "data/events", owner, repo, `${number}.ndjson`);
  if (existsSync(events)) {
    await mkdir(path.join(outDir, "data/events", owner, repo), { recursive: true });
    await cp(events, path.join(outDir, "data/events", owner, repo, `${number}.ndjson`));
  }

  const audioSrc = path.join(ROOT, "data/audio", owner, repo, String(number));
  const available = new Set(existsSync(audioSrc) ? await readdir(audioSrc) : []);
  let found = 0;
  let total = 0;
  for (const step of wt.steps) {
    const sentences = splitSentences(step.narration ?? "");
    for (let i = 0; i < sentences.length; i++) {
      total++;
      const name = `${step.id}-${i}-${sentenceHash(sentences[i], voiceId)}.mp3`;
      if (!available.has(name)) continue;
      const dest = path.join(outDir, "data/audio", owner, repo, String(number), step.id);
      await mkdir(dest, { recursive: true });
      await copyFile(path.join(audioSrc, name), path.join(dest, `${i}.mp3`));
      found++;
    }
  }
  console.log(`${spec}: walkthrough ✓, recording ${existsSync(events) ? "✓" : "—"}, audio ${found}/${total} sentences`);

  const shotsSrc = path.join(ROOT, "data/shots", owner, repo, String(number));
  if (existsSync(shotsSrc)) {
    await mkdir(path.join(outDir, "data/shots", owner, repo, String(number)), { recursive: true });
    await cp(shotsSrc, path.join(outDir, "data/shots", owner, repo, String(number)), { recursive: true });
    console.log(`  shots ✓`);
  }
}

// SPA fallback for viewer routes; /data and /assets must 404 when missing (the landing
// page probes /data/walkthroughs/... to decide which example cards to show).
await writeFile(
  path.join(outDir, "vercel.json"),
  JSON.stringify(
    {
      rewrites: [{ source: "/((?!data/|assets/).*)", destination: "/index.html" }],
      headers: [{ source: "/data/audio/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=86400" }] }],
    },
    null,
    2
  )
);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p, ...(e.isDirectory() ? await walk(p) : []));
  }
  return out;
}
const leaked = (await walk(outDir)).filter((p) => /outline/i.test(path.relative(outDir, p)));
if (leaked.length) throw new Error(`Outline files must not be published: ${leaked.join(", ")}`);
console.log(`static demo ready in ${outDir}`);
