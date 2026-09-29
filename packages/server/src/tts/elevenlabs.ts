/**
 * tts/elevenlabs.ts — ElevenLabs TTS helpers.
 *
 * - splitSentences  : same split the viewer uses
 * - sentenceHash    : stable cache key (sha256, first 16 chars)
 * - generateSentenceAudio : call ElevenLabs API, write mp3 to disk (cache-safe)
 * - pregen          : generate all narration sentences for a Walkthrough
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";

import type { Walkthrough } from "@pr-walkthrough/shared";

const TTS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const OUTPUT_FORMAT = "mp3_44100_128";
const MODEL_ID = "eleven_multilingual_v2";

/** Done-screen cue when a diagram is shown — keep in sync with the viewer. */
export const OUTRO_STEP_ID = "outro";
export const OUTRO_NARRATION = "Take a look at the final diagram of the fix.";

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------

/**
 * Split narration text into sentences.
 * Splits on period / question-mark / exclamation-mark followed by a space or
 * end-of-string — identical to the logic in the viewer.
 */
export function splitSentences(text: string): string[] {
  // Split after ./?/! that is followed by whitespace or end-of-string.
  // Keep the delimiter attached to the preceding sentence.
  const parts = text.split(/(?<=[.?!])\s+/);
  return parts.map(s => s.trim()).filter(s => s.length > 0);
}

// ---------------------------------------------------------------------------
// sentenceHash
// ---------------------------------------------------------------------------

/**
 * Stable 16-char hex cache key derived from the sentence text and voice id.
 * Re-generates whenever narration text or voice changes.
 */
export function sentenceHash(text: string, voiceId: string): string {
  return createHash("sha256")
    .update(voiceId)
    .update("\x00")
    .update(text)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// generateSentenceAudio
// ---------------------------------------------------------------------------

/**
 * Generate audio for a single sentence.
 * Returns the absolute path to the mp3 file.
 * If the file already exists, returns immediately without an API call.
 * Throws on non-2xx HTTP response.
 */
export async function generateSentenceAudio(
  sentence: string,
  voiceId: string,
  apiKey: string,
  outPath: string,
): Promise<string> {
  // Cache check — skip API call if file already on disk.
  try {
    await access(outPath);
    return outPath; // already exists
  } catch {
    // file does not exist — fall through
  }

  await mkdir(path.dirname(outPath), { recursive: true });

  const url = `${TTS_ENDPOINT}/${voiceId}?output_format=${OUTPUT_FORMAT}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: sentence, model_id: MODEL_ID }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs TTS error ${resp.status}: ${body}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  await writeFile(outPath, buffer);
  return outPath;
}

// ---------------------------------------------------------------------------
// pregen
// ---------------------------------------------------------------------------

/**
 * Pre-generate narration audio for a walkthrough (one file per sentence).
 * Pass `stepIds` to limit generation (e.g. voice-check samples for s1+s2 only).
 * Returns counts of newly generated vs cached files and total characters.
 */
export async function pregen(
  wt: Walkthrough,
  outDir: string,
  voiceId: string,
  apiKey: string,
  stepIds?: string[],
): Promise<{ generated: number; cached: number; totalChars: number }> {
  let generated = 0;
  let cached = 0;
  let totalChars = 0;
  const allow = stepIds && stepIds.length > 0 ? new Set(stepIds) : null;

  for (const step of wt.steps) {
    if (allow && !allow.has(step.id)) continue;
    if (!step.narration) continue;
    const sentences = splitSentences(step.narration);

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      totalChars += sentence.length;

      const hash = sentenceHash(sentence, voiceId);
      const filename = `${step.id}-${i}-${hash}.mp3`;
      const outPath = path.join(outDir, filename);

      // Check if already cached before calling the API.
      let wasCached = false;
      try {
        await access(outPath);
        wasCached = true;
      } catch {
        // not cached
      }

      await generateSentenceAudio(sentence, voiceId, apiKey, outPath);

      if (wasCached) {
        cached++;
      } else {
        generated++;
      }
    }
  }

  // Done-screen diagram cue (same text for every PR that has a graph).
  const wantOutro =
    (!allow || allow.has(OUTRO_STEP_ID)) &&
    (wt.graph?.nodes?.length ?? 0) > 0;
  if (wantOutro) {
    totalChars += OUTRO_NARRATION.length;
    const hash = sentenceHash(OUTRO_NARRATION, voiceId);
    const outPath = path.join(outDir, `${OUTRO_STEP_ID}-0-${hash}.mp3`);
    let wasCached = false;
    try {
      await access(outPath);
      wasCached = true;
    } catch {
      /* not cached */
    }
    await generateSentenceAudio(OUTRO_NARRATION, voiceId, apiKey, outPath);
    if (wasCached) cached++;
    else generated++;
  }

  return { generated, cached, totalChars };
}
