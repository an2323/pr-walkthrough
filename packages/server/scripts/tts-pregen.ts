/**
 * scripts/tts-pregen.ts
 *
 * Usage:
 *   pnpm --filter @pr-walkthrough/server tts:pregen <owner/repo#number>
 *   e.g. pnpm --filter @pr-walkthrough/server tts:pregen excalidraw/excalidraw#10295
 *
 * - Reads ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID from root .env
 * - Loads walkthrough from data/walkthroughs/{owner}/{repo}/{number}.json
 * - Calls pregen() and logs results + appends to docs/cost-log.md
 */

import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");

// ---------------------------------------------------------------------------
// Minimal .env parser (no external deps)
// ---------------------------------------------------------------------------

async function loadDotEnv(): Promise<Record<string, string>> {
  const envPath = path.join(ROOT, ".env");
  let raw: string;
  try {
    raw = await readFile(envPath, "utf-8");
  } catch {
    return {};
  }
  const result: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: tts:pregen <owner/repo#number>");
    console.error("  e.g. tts:pregen excalidraw/excalidraw#10295");
    process.exit(1);
  }

  // Parse "owner/repo#number"
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(arg);
  if (!match) {
    console.error(`Invalid argument: ${arg}  (expected owner/repo#number)`);
    process.exit(1);
  }
  const [, owner, repo, numberStr] = match;
  const number = parseInt(numberStr, 10);

  // Load env vars from root .env (fall back to process.env for CI/container use).
  const envVars = await loadDotEnv();
  const apiKey = process.env.ELEVENLABS_API_KEY ?? envVars["ELEVENLABS_API_KEY"] ?? "";
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? envVars["ELEVENLABS_VOICE_ID"] ?? "";

  if (!apiKey) {
    console.error("ELEVENLABS_API_KEY is not set. Add it to the root .env file.");
    process.exit(1);
  }
  if (!voiceId) {
    console.error("ELEVENLABS_VOICE_ID is not set. Add it to the root .env file.");
    process.exit(1);
  }

  // Load walkthrough JSON.
  const wtPath = path.join(ROOT, "data/walkthroughs", owner, repo, `${number}.json`);
  let wt: import("@pr-walkthrough/shared").Walkthrough;
  try {
    const raw = await readFile(wtPath, "utf-8");
    wt = JSON.parse(raw);
  } catch {
    console.error(`Walkthrough not found at ${wtPath}`);
    process.exit(1);
  }

  // Resolve output directory.
  const outDir = path.join(ROOT, "data/audio", owner, repo, String(number));
  await mkdir(outDir, { recursive: true });

  // Dynamically import pregen from the src module (tsx resolves it at runtime).
  const { pregen } = await import("../src/tts/elevenlabs.js");

  console.log(`Pre-generating audio for ${owner}/${repo}#${number}…`);
  const startedAt = Date.now();
  const { generated, cached, totalChars } = await pregen(wt, outDir, voiceId, apiKey);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`Done in ${elapsed}s:`);
  console.log(`  Generated: ${generated} new`);
  console.log(`  Cached:    ${cached}`);
  console.log(`  Total chars: ${totalChars}`);

  // Append to cost log.
  const costLogPath = path.join(ROOT, "docs/cost-log.md");
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const logLine =
    `| ${timestamp} | tts:pregen ${owner}/${repo}#${number} | ` +
    `generated=${generated} cached=${cached} chars=${totalChars} elapsed=${elapsed}s |\n`;

  try {
    await appendFile(costLogPath, logLine, "utf-8");
  } catch {
    // cost-log.md may not exist yet — create header + entry.
    const header =
      `# Cost Log\n\n` +
      `| Timestamp | Run | Details |\n` +
      `|-----------|-----|---------|\n`;
    await appendFile(costLogPath, header + logLine, "utf-8");
  }

  console.log(`Appended to docs/cost-log.md`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
