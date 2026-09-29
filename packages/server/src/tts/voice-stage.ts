/**
 * voice-stage.ts — the last pipeline stage: narrate the finished walkthrough (ElevenLabs), so it
 * plays with the real voice the moment the reader opens it.
 *
 * Only here, inside the gated pipeline, is new audio paid for — `/api/audio` keeps serving what
 * exists (TTS_GENERATE stays off for visitors). A voice failure never fails the run: the viewer
 * falls back to the browser's own voice, and the stage says so.
 */

import path from "node:path";

import type { Walkthrough } from "@pr-walkthrough/shared";

import { blobsEnabled, uploadDir } from "../blobs.js";
import { pregen } from "./elevenlabs.js";

export type VoiceOutcome =
  | { status: "ok"; generated: number; cached: number; chars: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** Voice is on when a key + voice are configured, unless TTS_PREGEN=0. */
export function voicingConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID && process.env.TTS_PREGEN !== "0";
}

export async function voiceWalkthrough(wt: Walkthrough, root: string): Promise<VoiceOutcome> {
  if (!voicingConfigured()) return { status: "skipped", reason: "narration voice isn't configured on this server" };
  const [owner, repo] = wt.pr.repo.split("/");
  const dir = path.join(root, "data/audio", owner, repo, String(wt.pr.number));
  try {
    const r = await pregen(wt, dir, process.env.ELEVENLABS_VOICE_ID!, process.env.ELEVENLABS_API_KEY!);
    // Durable copy: the VM's disk is a cache, Supabase Storage is what survives a rebuild.
    if (blobsEnabled()) await uploadDir(dir, `audio/${owner}/${repo}/${wt.pr.number}`, /\.mp3$/i);
    return { status: "ok", generated: r.generated, cached: r.cached, chars: r.totalChars };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", reason: message.slice(0, 200) };
  }
}
