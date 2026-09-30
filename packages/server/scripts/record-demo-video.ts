/**
 * record-demo-video.ts — records the demo video from the REAL site, then mixes the real narration and music.
 *
 *   pnpm --filter @pr-walkthrough/server exec tsx scripts/record-demo-video.ts \
 *       --site https://130-61-220-249.sslip.io --cut 45 --out ../../docs/video/out
 *
 * What it films (nothing is faked, nothing costs anything): the landing page, a PR pasted into the input
 * (the live "what you'll get" line), the replay of a real finished analysis (GET /api/runs/.../events), and
 * a step of the finished walkthrough. Captions and a cursor are drawn into the page; the screen is captured with
 * the DevTools screencast; ffmpeg turns the frames into video and mixes the narration clips (the same mp3s the
 * viewer plays) over a music track, ducked under the voice.
 *
 * Output per cut: video-<cut>.mp4 (silent), and for each music file a <name>-<cut>-<track>.mp4.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "playwright";


// ---- arguments -------------------------------------------------------------------------------
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const SITE = arg("site", "https://130-61-220-249.sslip.io").replace(/\/$/, "");
const CUT = Number(arg("cut", "45")) <= 30 ? 25 : 45;
const OUT = path.resolve(arg("out", "docs/video/out"));
const MUSIC = arg("music", "").split(",").filter(Boolean); // mp3 paths
// Presenter voice: ElevenLabs "Sarah" (a different voice from the site's narration), or --voice say (macOS), or --voice off.
const VOICE_KIND = arg("voice", "eleven");
const VOICE_ID = arg("voice-id", "EXAVITQu4vr4xnSDxMaL");
const SAY_VOICE = arg("say-voice", "Daniel (Enhanced)");
const VO_ON = VOICE_KIND !== "off";
// --only viewer: film just the finished walkthrough (Start → Next → Listen), for splicing onto footage recorded earlier.
const ONLY = arg("only", "");
const SPEED = Number(arg("speed", "0.84")); // presenter pace (ElevenLabs speed 0.7–1.2); the default reads clearly and slowly
const ENV_FILE = arg("env", "");
if (ENV_FILE) process.loadEnvFile(path.resolve(ENV_FILE));
const VOICE_CACHE = path.join(OUT, "voice-cache");
const PR = { owner: "excalidraw", repo: "excalidraw", number: 10295 };
const PASTE = arg("paste", `https://github.com/${PR.owner}/${PR.repo}/pull/${PR.number}`);
const REPLAY_SECONDS = CUT === 25 ? 13 : 22; // long enough for one spoken line per phase // how long the recorded run takes on screen
const W = 1280;
const H = 666; // the page; the 81 px under it (at 1920×1080) is the caption bar
const SCALE = 1.5;
const BAR = 81;
const FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";

const work = path.join(OUT, `work-${CUT}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(path.join(work, "frames"), { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();

// ---- in-page overlay: caption pill + cursor --------------------------------------------------
const OVERLAY = `
(() => {
  const start = () => {
  if (window.__overlay) return; window.__overlay = true;
  const css = document.createElement('style');
  css.textContent = \`
    #__cur{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;
      transform:translate(-100px,-100px);transition:transform .03s linear}
    #__cur::before{content:'';position:absolute;inset:0;border-radius:50%;background:rgba(120,169,255,.35);border:2px solid #78a9ff}
    #__cur.click::before{animation:__pop .4s ease-out}
    @keyframes __pop{0%{transform:scale(1)}50%{transform:scale(1.9);background:rgba(120,169,255,.6)}100%{transform:scale(1)}}
  \`;
  document.documentElement.appendChild(css);
  const cur = document.createElement('div'); cur.id = '__cur';
  document.documentElement.append(cur);
  addEventListener('mousemove', (e) => { cur.style.transform = 'translate(' + (e.clientX - 11) + 'px,' + (e.clientY - 11) + 'px)'; }, true);
  addEventListener('mousedown', () => { cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click'); }, true);
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, reducedMotion: "no-preference" });
  await context.addInitScript(OVERLAY);
  await context.addInitScript(`(() => {
    const plays = (window.__plays = []);
    const orig = HTMLMediaElement.prototype.play;
    window.__stopAfter = Infinity; window.__ended = 0; window.__stoppedAt = 0;
    HTMLMediaElement.prototype.play = function () {
      plays.push({ src: this.currentSrc || this.src, at: Date.now() });
      if (!this.__hooked) {
        this.__hooked = true;
        // capture phase: runs before the viewer's own "ended" handler, so the next sentence never starts
        this.addEventListener('ended', () => {
          window.__ended++;
          if (window.__ended >= window.__stopAfter && !window.__stoppedAt) { window.__stoppedAt = Date.now(); document.querySelector('.listen')?.click(); }
        }, true);
      }
      return orig.apply(this, arguments);
    };
  })();`);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  // ---- capture ---------------------------------------------------------------------------
  const frames: { ts: number; file: string }[] = [];
  let n = 0;
  cdp.on("Page.screencastFrame", (f: { data: string; metadata: { timestamp: number }; sessionId: number }) => {
    const file = path.join(work, "frames", `f${String(n++).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ ts: f.metadata.timestamp, file });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });

  const marks: Record<string, number> = {};
  let t0 = 0;
  const now = () => (Date.now() - t0) / 1000;
  const mark = (name: string) => { marks[name] = now(); console.log(`${now().toFixed(1).padStart(5)}s  ${name}`); };
  // Captions are burned in by ffmpeg into the bar under the page (so they never cover anything).
  const captions: { start: number; end: number | null; text: string }[] = [];
  const caption = async (html: string | null) => {
    const t = now();
    const open = captions.at(-1);
    if (open && open.end === null) open.end = t;
    if (html) captions.push({ start: t, end: null, text: html.replace(/<[^>]+>/g, "") });
  };

  // ---- presenter voice: a different voice from the site's narration; lines queue up, never overlap each other,
  //      and never start while the site's own narration is playing ---------------------------------
  const presenter: { file: string; at: number; seconds: number; text: string }[] = [];
  const cache = new Map<string, { file: string; seconds: number }>();
  const synth = async (text: string): Promise<{ file: string; seconds: number }> => {
    const hit = cache.get(text);
    if (hit) return hit;
    let file: string;
    if (VOICE_KIND === "say") {
      const base = path.join(work, `say-${cache.size}`);
      sh("say", ["-v", SAY_VOICE, "-r", "172", "-o", `${base}.aiff`, text]);
      sh("ffmpeg", ["-y", "-i", `${base}.aiff`, "-ar", "44100", "-ac", "1", `${base}.wav`]);
      file = `${base}.wav`;
    } else {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) throw new Error("ELEVENLABS_API_KEY is not set (pass --env /path/to/.env)");
      mkdirSync(VOICE_CACHE, { recursive: true });
      // cached by voice + settings + text: a re-run never pays for a line it already has
      const settings = { stability: 0.6, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: SPEED };
      file = path.join(VOICE_CACHE, `${createHash("sha256").update(VOICE_ID).update("\0").update(JSON.stringify(settings)).update("\0").update(text).digest("hex").slice(0, 16)}.mp3`);
      if (!existsSync(file)) {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: settings }),
        });
        if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
    }
    const seconds = Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
    const made = { file, seconds };
    cache.set(text, made);
    return made;
  };
  let ttsWindow = { a: 0, b: 0 }; // seconds since t0: while the site narrates, the music is (almost) gone
  let voiceFreeAt = 0; // seconds since t0: the earliest the presenter may speak again
  const ttsBusy = { until: 0 }; // seconds since t0: the site's narration is playing until then
  /** Caption + spoken line at the same moment; returns when the line ends (seconds since t0). */
  const narrate = async (text: string, spoken = true): Promise<number> => {
    await caption(text);
    if (!VO_ON || !spoken) return now();
    const clip = await synth(text);
    const at = Math.max(now(), voiceFreeAt, ttsBusy.until);
    presenter.push({ file: clip.file, at, seconds: clip.seconds, text });
    voiceFreeAt = at + clip.seconds + 0.25;
    return at + clip.seconds;
  };

  const glide = async (x: number, y: number, steps = 30) => { await page.mouse.move(x, y, { steps }); };
  const center = async (sel: string) => {
    const el = page.locator(sel).first();
    await el.scrollIntoViewIfNeeded();
    const b = await el.boundingBox();
    if (!b) throw new Error(`not visible: ${sel}`);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const click = async (sel: string) => {
    const { x, y } = await center(sel);
    await glide(x, y);
    await sleep(180);
    await page.mouse.down();
    await page.mouse.up();
  };

  // ---- how fast the recorded run is replayed (it took ~18 minutes) ------------------------
  const probe = await (await fetch(`${SITE}/api/runs/${PR.owner}/${PR.repo}/${PR.number}/events?speed=1000000`)).text();
  const lastEvent = probe.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { t: number }).at(-1);
  const speed = Math.max(1, Math.round((lastEvent?.t ?? 1_000_000) / 1000 / REPLAY_SECONDS));

  // ---- the ANALYSE click is staged: the pasted PR is shown as a new one, POST /api/analyze answers with a job,
  //      and that job's event stream IS the recorded real run, replayed at `speed`. Everything else is the site. ----
  let staged = true;
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/config", (r) => r.fulfill(json({ liveAnalysis: true, dailyLimit: 20, usedToday: 3 })));
  await page.route("**/api/preview*", (r) =>
    staged
      ? r.fulfill(json({ owner: PR.owner, repo: PR.repo, number: PR.number, analysed: false, title: "fix: close floating sidebar on main menu open", additions: 19, deletions: 7, files: 5, screenshots: { available: true } }))
      : r.continue()
  );
  await page.route(`**/api/walkthroughs/${PR.owner}/${PR.repo}/${PR.number}`, (r) =>
    staged && r.request().method() === "HEAD" ? r.fulfill({ status: 404 }) : r.continue()
  );
  await page.route("**/api/analyze", (r) => r.fulfill(json({ jobId: "demo" }, 202)));
  await page.route("**/api/jobs/demo/events", (r) =>
    r.continue({ url: `${SITE}/api/runs/${PR.owner}/${PR.repo}/${PR.number}/events?speed=${speed}` })
  );

  // The presenter's lines are made (or fetched from the cache) BEFORE the clock starts, so none arrives late.
  if (VO_ON) {
    const lines = [
      "Bob reads the whole PR — and runs it.",
      "Paste a PR. See what you'll get before you start.",
      "Press Analyse. Bob starts on the PR.",
      "Bob reads the diff and the code around it.",
      "Then he runs it — old commit and new commit.",
      "Same clicks, both versions: the proof.",
      "Done. The screenshots come from the running app.",
      "And then it explains every change, read aloud.",
      "Paste a PR. Get the proof. Understand the fix.",
    ];
    for (const l of lines) await synth(l);
  }

  // ---- go --------------------------------------------------------------------------------
  await page.goto(ONLY === "viewer" ? `${SITE}/${PR.owner}/${PR.repo}/${PR.number}` : SITE + "/", { waitUntil: "networkidle" });
  await page.mouse.move(W * 0.72, H * 0.3);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: Math.round(W * SCALE), maxHeight: Math.round(H * SCALE), everyNthFrame: 1 });
  t0 = Date.now();
  mark("landing");

  let l7 = 0;
  if (ONLY !== "viewer") {
  // 1 — the page
  const l1 = await narrate("Bob reads the whole PR — and runs it.");
  await sleep(Math.max(CUT === 45 ? 3400 : 2400, (l1 - now()) * 1000 + 300));

  // 2 — paste a PR: the page says what you will get before you press anything
  const l2 = await narrate("Paste a PR. See what you'll get before you start.", CUT === 45);
  await click('input[aria-label="GitHub PR URL"]');
  await page.keyboard.type(PASTE, { delay: 32 });
  await page.locator(".lp-pv--ok, .lp-pv--part, .lp-pv--bad, .lp-pv--done").first().waitFor({ timeout: 15000 }).catch(() => {});
  mark("preview");
  await sleep(Math.max(CUT === 45 ? 2600 : 1800, (l2 - now()) * 1000 + 300));

  // 3 — press Analyse
  const l3 = await narrate("Press Analyse. Bob starts on the PR.");
  await sleep(Math.max(0, (Math.min(l3, now() + 1.6) - now()) * 1000));
  await click("button:has-text('Analyse')");
  mark("analyse");

  // 4 — the real run, played back: captions follow what the screen is doing
  await page.waitForURL(/progress/, { timeout: 15000 });
  mark("progress");
  const phase = async (): Promise<string> => (await page.locator(".pg-pane-head h3").first().textContent().catch(() => "")) ?? "";
  const spoken = new Set<string>();
  const say = async (key: string, text: string, voiced = true) => { if (!spoken.has(key)) { spoken.add(key); await narrate(text, voiced); mark(`caption:${key}`); } };
  const deadline = Date.now() + 70_000;
  while (Date.now() < deadline) {
    if (await page.locator(".pg-done").count()) break;
    const h = await phase();
    if (/What changed/.test(h)) await say("read", "Bob reads the diff and the code around it.", CUT === 45);
    else if (/Reproducing/.test(h)) await say("run", "Then he runs it — old commit and new commit.");
    else if (/Reproduced|fix holds/.test(h)) await say("proof", "Same clicks, both versions: the proof.");
    await sleep(200);
  }
  mark("done");
  l7 = await narrate("Done. The screenshots come from the running app.", CUT === 45);
  staged = false;
  await page.waitForURL(new RegExp(`/${PR.owner}/${PR.repo}/${PR.number}$`), { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  }

  // 5 — the finished walkthrough, read aloud by the site itself: press "Listen" and let it play (Auto mode)
  mark("viewer");
  const l8 = await narrate(ONLY === "viewer" ? "Then it explains every change: the diagram and the code, read aloud." : "And then it explains every change, read aloud.");
  await sleep(Math.max(1200, (Math.max(l7, l8) - now()) * 1000 + 350)); // the presenter finishes before the site starts talking
  if (ONLY === "viewer") {
    await click('button:has-text("Start")');
    await sleep(1100); // the first step: the symptoms
    await click('button:has-text("Next")');
    await sleep(900); // the stacking diagram and the code
  }
  await click(".listen");
  await sleep(700);
  mark("listen");
  // Let the site's own narration play for N sentences, then the page itself presses Pause right as the Nth one
  // ends (see the init script) — so the button ends in a true "Resume" state and no further sentence starts.
  await page.evaluate((n) => { (window as unknown as { __stopAfter: number }).__stopAfter = n; }, CUT === 45 ? 2 : 1);
  const listenAt = Date.now();
  let stoppedAt = 0;
  while (Date.now() - listenAt < 45_000) {
    stoppedAt = (await page.evaluate(() => (window as unknown as { __stoppedAt: number }).__stoppedAt)) as number;
    if (stoppedAt) break;
    await sleep(120);
  }
  if (!stoppedAt) throw new Error("the site's narration did not finish in time");
  ttsBusy.until = (stoppedAt - t0) / 1000;
  ttsWindow = { a: marks["listen"]! - 0.9, b: ttsBusy.until + 0.5 };
  await sleep(500); // the Resume state is on screen
  const l9 = await narrate("Paste a PR. Get the proof. Understand the fix.");
  await sleep(Math.max(1200, (l9 - now()) * 1000 + 500));
  mark("end");
  const total = now();
  // What the site actually played (and when), so the mix puts each clip exactly where the page started it.
  const played = (await page.evaluate(() => (window as unknown as { __plays?: { src: string; at: number }[] }).__plays ?? [])) as { src: string; at: number }[];

  await cdp.send("Page.stopScreencast");
  await sleep(300);
  await browser.close();

  // ---- frames → silent video ---------------------------------------------------------------
  const list: string[] = [];
  const endTs = frames[0]!.ts + total;
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.ts ?? Math.max(f.ts + 0.05, endTs);
    list.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.ts).toFixed(4)}`);
  });
  list.push(`file '${frames.at(-1)!.file}'`);
  const listFile = path.join(work, "frames.txt");
  writeFileSync(listFile, list.join("\n"));
  const video = path.join(OUT, `video-${CUT}.mp4`);
  const closing = captions.at(-1);
  if (closing && closing.end === null) closing.end = total;
  const draw = captions.map((c, i) => {
    const f = path.join(work, `caption-${i}.txt`);
    writeFileSync(f, c.text);
    return `drawtext=fontfile='${FONT}':textfile='${f}':fontsize=34:fontcolor=0xf4f4f4:x=(w-text_w)/2:y=${1080 - BAR}+(${BAR}-text_h)/2:enable='gte(t,${c.start.toFixed(2)})*lt(t,${(c.end ?? total).toFixed(2)})'`;
  });
  const vf = [`fps=30`, `scale=1920:${1080 - BAR}:flags=lanczos`, `pad=1920:1080:0:0:color=0x141414`, `drawbox=x=0:y=${1080 - BAR}:w=1920:h=2:color=0x333a42:t=fill`, ...draw].join(",");
  sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", vf, "-t", total.toFixed(2), "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-pix_fmt", "yuv420p", video]);
  const vdur = Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).trim());
  writeFileSync(path.join(OUT, `timeline-${CUT}.json`), JSON.stringify({ total, videoSeconds: vdur, marks, captions, played, presenter, speed }, null, 2));
  console.log(`video: ${video}  (${vdur.toFixed(1)} s, ${frames.length} frames)`);

  // ---- mix: narration over music, music ducked under the voice -----------------------------
  if (played.length === 0) throw new Error("the page played no narration — nothing to mix (is ELEVENLABS_* set, or the site's TTS cached?)");
  const voIn: { file: string; at: number }[] = [];
  for (const line of presenter) {
    voIn.push({ file: line.file, at: line.at });
    console.log(`${line.at.toFixed(1).padStart(5)}s  presenter: ${line.text}`);
  }
  for (const [i, pl] of played.entries()) {
    const res = await fetch(pl.src);
    if (!res.ok) throw new Error(`cannot fetch ${pl.src}: HTTP ${res.status}`);
    const file = path.join(work, `vo-${i}.mp3`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    voIn.push({ file, at: (pl.at - t0) / 1000 });
    console.log(`${((pl.at - t0) / 1000).toFixed(1).padStart(5)}s  narration: ${pl.src.split("/api/audio/")[1] ?? pl.src}`);
  }
  // No two voices at once: the presenter and the site's narration must never overlap.
  {
    const dur = (f: string) => Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim());
    const spans = voIn.map((v) => ({ file: path.basename(v.file), a: v.at, b: v.at + dur(v.file) })).sort((x, y) => x.a - y.a);
    const clashes = spans.flatMap((x, i) => (spans[i + 1] && spans[i + 1]!.a < x.b - 0.05 ? [`${x.file} (${x.a.toFixed(1)}–${x.b.toFixed(1)}) overlaps ${spans[i + 1]!.file} (from ${spans[i + 1]!.a.toFixed(1)})`] : []));
    if (clashes.length > 0) throw new Error(`voices overlap:\n${clashes.join("\n")}`);
    console.log(`voices: ${spans.length} clips, no overlap; last ends at ${spans.at(-1)!.b.toFixed(1)} s of ${vdur.toFixed(1)} s`);
  }
  if (ONLY === "viewer") {
    writeFileSync(path.join(OUT, `voices-${ONLY}.json`), JSON.stringify({ videoSeconds: vdur, ttsWindow, voices: voIn }, null, 2));
    console.log(`viewer scene: ${video} + voices-${ONLY}.json (work folder kept: ${work})`);
    return;
  }
  MUSIC.forEach((music, idx) => {
    const name = path.basename(music).replace(/\.mp3$/i, "").slice(0, 28);
    const outFile = path.join(OUT, `demo-${CUT}s-track${idx + 1}.mp4`);
    const inputs = ["-i", video, "-i", path.resolve(music), ...voIn.flatMap((v) => ["-i", v.file])];
    const voLabels = voIn.map((_, i) => `[v${i}]`).join("");
    const voChain = voIn.map((v, i) => `[${i + 2}:a]adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)},volume=1.0[v${i}]`).join(";");
    const fade = `afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, vdur - 2.4).toFixed(2)}:d=2.4`;
    // The music level is a fixed envelope, not a compressor that pumps: full level, a gentle dip under the
    // presenter, and almost nothing for the whole stretch where the site's own narration is shown.
    const BASE = 0.4, DIP = 0.2, LOW = 0.02, F = 0.6;
    const trap = (a: number, b: number) => `clip(min((t-${(a - F).toFixed(2)})/${F},(${(b + F).toFixed(2)}-t)/${F}),0,1)`;
    const maxOf = (xs: string[]): string => (xs.length === 0 ? "0" : xs.length === 1 ? xs[0]! : `max(${xs[0]},${maxOf(xs.slice(1))})`);
    const wp = maxOf(presenter.map((l) => trap(l.at, l.at + l.seconds)));
    const wt = trap(ttsWindow.a, ttsWindow.b);
    const dip = `(${BASE}+(${DIP - BASE})*${wp})`;
    const env = `${dip}+(${LOW}-${dip})*${wt}`;
    const filter = [
      `[1:a]atrim=0:${vdur.toFixed(2)},asetpts=PTS-STARTPTS,volume='${env}':eval=frame,${fade}[m]`,
      voChain,
      `${voLabels}amix=inputs=${voIn.length}:normalize=0,apad=whole_dur=${vdur.toFixed(2)}[vo]`,
      `[m][vo]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
    ].join(";");
    sh("ffmpeg", ["-y", ...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", vdur.toFixed(2), "-movflags", "+faststart", outFile]);
    console.log(`track ${idx + 1} (${name}): ${outFile}`);
  });
  console.log(`frames kept in ${work} (delete when done)`);
  void readdirSync;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export type { Page };
