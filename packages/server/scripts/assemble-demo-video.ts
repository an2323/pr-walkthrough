/**
 * assemble-demo-video.ts — splice a re-filmed scene onto the footage of an earlier recording, and mix the sound again.
 *
 *   tsx scripts/assemble-demo-video.ts --a <earlier.mp4> --a-end 29.4 --a-voices a-voices.json \
 *       --b <scene.mp4> --b-voices voices-viewer.json --music track2.mp3 --out demo.mp4 [--poster-at 27.5 --poster poster.jpg]
 *
 * Nothing is re-recorded: scene A is the first `--a-end` seconds of the earlier video (captions are burned into it), scene B is
 * a fresh recording (record-demo-video.ts --only viewer). The presenter's lines for A come from a small json
 * ([{ "at": 3.4, "text": "…" }], resolved through the same voice cache); B brings its own voices.json. Music: full level, a dip under
 * the presenter, almost silent while the site's own narration plays (same envelope as the recorder).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const arg = (name: string, fallback = ""): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const dur = (f: string) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim());

const A = path.resolve(arg("a"));
const A_END = Number(arg("a-end"));
const B = path.resolve(arg("b"));
const OUT = path.resolve(arg("out", "demo.mp4"));
const MUSIC = path.resolve(arg("music"));
const CACHE = path.resolve(arg("voice-cache", "docs/video/out/voice-cache"));
const VOICE_ID = arg("voice-id", "EXAVITQu4vr4xnSDxMaL");
const SPEED = Number(arg("speed", "0.84"));
if (!A || !A_END || !B || !MUSIC) throw new Error("need --a, --a-end, --b and --music");

// the recorder's cache key: voice + settings + text
const cacheFile = (text: string): string => {
  const settings = { stability: 0.6, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: SPEED };
  const h = createHash("sha256").update(VOICE_ID).update("\0").update(JSON.stringify(settings)).update("\0").update(text).digest("hex").slice(0, 16);
  return path.join(CACHE, `${h}.mp3`);
};

const tmp = path.join(path.dirname(OUT), `assemble-tmp`);
sh("mkdir", ["-p", tmp]);

// ---- picture: A (cut) + B ---------------------------------------------------------------
const aCut = path.join(tmp, "a.mp4");
sh("ffmpeg", ["-y", "-ss", "0", "-t", String(A_END), "-i", A, "-an", "-vf", "fps=30", "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-pix_fmt", "yuv420p", aCut]);
const dA = dur(aCut);
const silent = path.join(tmp, "ab.mp4");
sh("ffmpeg", ["-y", "-i", aCut, "-i", B, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-pix_fmt", "yuv420p", silent]);
const total = dur(silent);

// ---- voices ------------------------------------------------------------------------------
type Voice = { file: string; at: number; presenter: boolean };
const aVoices = (JSON.parse(readFileSync(path.resolve(arg("a-voices")), "utf-8")) as { at: number; text: string }[]).map<Voice>((v) => ({ file: cacheFile(v.text), at: v.at, presenter: true }));
const bJson = JSON.parse(readFileSync(path.resolve(arg("b-voices")), "utf-8")) as { ttsWindow: { a: number; b: number }; voices: { file: string; at: number }[] };
const bVoices = bJson.voices.map<Voice>((v) => ({ file: v.file, at: dA + v.at, presenter: v.file.includes("voice-cache") }));
const voices = [...aVoices, ...bVoices].sort((x, y) => x.at - y.at);
const spans = voices.map((v) => ({ ...v, b: v.at + dur(v.file) }));
const clashes = spans.flatMap((x, i) => (spans[i + 1] && spans[i + 1]!.at < x.b - 0.05 ? [`${path.basename(x.file)} (${x.at.toFixed(1)}–${x.b.toFixed(1)}) overlaps the next clip (from ${spans[i + 1]!.at.toFixed(1)})`] : []));
if (clashes.length > 0) throw new Error(`voices overlap:\n${clashes.join("\n")}`);
console.log(`picture ${dA.toFixed(1)} s + ${(total - dA).toFixed(1)} s = ${total.toFixed(1)} s; ${voices.length} voice clips, no overlap; last ends at ${spans.at(-1)!.b.toFixed(1)} s`);

// ---- mix (same envelope as the recorder) -------------------------------------------------
const BASE = 0.4, DIP = 0.2, LOW = 0.02, F = 0.6;
const trap = (a: number, b: number) => `clip(min((t-${(a - F).toFixed(2)})/${F},(${(b + F).toFixed(2)}-t)/${F}),0,1)`;
const maxOf = (xs: string[]): string => (xs.length === 0 ? "0" : xs.length === 1 ? xs[0]! : `max(${xs[0]},${maxOf(xs.slice(1))})`);
const wp = maxOf(spans.filter((s) => s.presenter).map((s) => trap(s.at, s.b)));
const wt = trap(dA + bJson.ttsWindow.a, dA + bJson.ttsWindow.b);
const dip = `(${BASE}+(${DIP - BASE})*${wp})`;
const env = `${dip}+(${LOW}-${dip})*${wt}`;
const inputs = ["-i", silent, "-i", MUSIC, ...voices.flatMap((v) => ["-i", v.file])];
const voChain = voices.map((v, i) => `[${i + 2}:a]adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)}[v${i}]`).join(";");
const fade = `afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, total - 2.4).toFixed(2)}:d=2.4`;
const filter = [
  `[1:a]atrim=0:${total.toFixed(2)},asetpts=PTS-STARTPTS,volume='${env}':eval=frame,${fade}[m]`,
  voChain,
  `${voices.map((_, i) => `[v${i}]`).join("")}amix=inputs=${voices.length}:normalize=0,apad=whole_dur=${total.toFixed(2)}[vo]`,
  `[m][vo]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
].join(";");
sh("ffmpeg", ["-y", ...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", total.toFixed(2), "-movflags", "+faststart", OUT]);
console.log(`written: ${OUT} (${dur(OUT).toFixed(1)} s)`);

const posterAt = arg("poster-at");
if (posterAt && arg("poster")) {
  sh("ffmpeg", ["-y", "-ss", posterAt, "-i", OUT, "-frames:v", "1", "-vf", "scale=1280:-1", "-q:v", "3", path.resolve(arg("poster"))]);
  console.log(`poster: ${arg("poster")} (frame at ${posterAt} s)`);
}
