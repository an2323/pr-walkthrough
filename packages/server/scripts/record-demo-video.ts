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
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const PR = { owner: "excalidraw", repo: "excalidraw", number: 10295 };
const PASTE = arg("paste", "https://github.com/excalidraw/excalidraw/pull/11680");
const REPLAY_SECONDS = CUT === 25 ? 7 : 16; // how long the recorded run takes on screen
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

// ---- narration clips (the ones the viewer plays) --------------------------------------------
async function clip(stepId: string, sentence: number): Promise<{ file: string; seconds: number }> {
  const file = path.join(work, `vo-${stepId}-${sentence}.mp3`);
  const res = await fetch(`${SITE}/api/audio/${PR.owner}/${PR.repo}/${PR.number}/${stepId}/${sentence}.mp3`);
  if (!res.ok) throw new Error(`no narration for ${stepId}/${sentence}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const seconds = Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
  return { file, seconds };
}

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

  // ---- narration clips first (so the script knows how long each step must stay) ------------
  const vo1 = await clip("s2", 0);
  const vo2 = CUT === 45 ? await clip("s2", 1) : null;

  // ---- go --------------------------------------------------------------------------------
  await page.goto(SITE + "/", { waitUntil: "networkidle" });
  await page.mouse.move(W * 0.72, H * 0.3);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: Math.round(W * SCALE), maxHeight: Math.round(H * SCALE), everyNthFrame: 1 });
  t0 = Date.now();
  mark("landing");

  // 1 — the page
  await caption("Bob reads the whole PR — <b>and runs it</b>.");
  await sleep(CUT === 45 ? 3400 : 2200);

  // 2 — paste a PR (45 s cut only): the page says what you will get before you press anything
  if (CUT === 45) {
    await caption("Paste a PR. <b>See what you'll get</b> before you start.");
    await click('input[aria-label="GitHub PR URL"]');
    await page.keyboard.type(PASTE, { delay: 32 });
    await page.locator(".lp-pv--ok, .lp-pv--part, .lp-pv--bad, .lp-pv--done").first().waitFor({ timeout: 15000 }).catch(() => {});
    mark("preview");
    await sleep(2600);
    await page.fill('input[aria-label="GitHub PR URL"]', "");
    await sleep(300);
  }

  // 3 — to the finished analyses, press "Watch the run" on #10295
  await caption(null);
  await page.evaluate(() => document.getElementById("analysed")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  await sleep(1100);
  const watch = `article:has-text("#${PR.number}") a:has-text("Watch the run")`;
  await page.locator(watch).first().waitFor({ timeout: 10000 });
  await click(watch);

  // 4 — the real run, played back: captions follow what the screen is doing
  await page.waitForURL(/progress/, { timeout: 15000 }).catch(() => {});
  // the replay pace is set by ?speed= (the recorded run took ~18 minutes)
  const url = new URL(page.url());
  const probe = await (await fetch(`${SITE}/api/runs/${PR.owner}/${PR.repo}/${PR.number}/events?speed=1000000`)).text();
  const last = probe.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as { t: number }).at(-1);
  const speed = Math.max(1, Math.round((last?.t ?? 1_000_000) / 1000 / REPLAY_SECONDS));
  url.searchParams.set("speed", String(speed));
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  mark("progress");

  const phase = async (): Promise<string> => (await page.locator(".pg-pane-head h3").first().textContent().catch(() => "")) ?? "";
  const spoken = new Set<string>();
  const say = async (key: string, html: string) => { if (!spoken.has(key)) { spoken.add(key); await caption(html); mark(`caption:${key}`); } };
  const deadline = Date.now() + 70_000;
  while (Date.now() < deadline) {
    if (await page.locator(".pg-done").count()) break;
    const h = await phase();
    if (/What changed/.test(h)) await say("read", "Bob <b>reads</b> the diff and the code around it.");
    else if (/Reproducing/.test(h)) await say("run", "Then he <b>runs it</b> — old commit and new commit.");
    else if (/Reproduced|fix holds/.test(h)) await say("proof", "Same clicks, both versions: <b>the proof</b>.");
    await sleep(200);
  }
  mark("done");
  await caption("Done — the screenshots come from the running app.");
  await sleep(CUT === 45 ? 1600 : 900);

  // 5 — the finished walkthrough: one step, read aloud
  await page.goto(`${SITE}/${PR.owner}/${PR.repo}/${PR.number}`, { waitUntil: "networkidle" });
  mark("viewer");
  await caption("…and <b>explains every change</b>, read aloud.");
  await sleep(CUT === 45 ? 2300 : 1500);
  await click('button:has-text("Start")');
  await sleep(CUT === 45 ? 1800 : 1000); // the first step: the symptoms
  await click('button:has-text("Next")');
  await sleep(700);
  mark("vo1");
  await sleep(vo1.seconds * 1000 + 350);
  if (vo2) {
    mark("vo2");
    await sleep(vo2.seconds * 1000 + 350);
  }
  await caption("Paste a PR. Get the proof. <b>Understand the fix.</b>");
  await sleep(CUT === 45 ? 1800 : 1200);
  mark("end");
  const total = now();

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
    return `drawtext=fontfile='${FONT}':textfile='${f}':fontsize=34:fontcolor=0xf4f4f4:x=(w-text_w)/2:y=${1080 - BAR}+(${BAR}-text_h)/2:enable='between(t,${c.start.toFixed(2)},${(c.end ?? total).toFixed(2)})'`;
  });
  const vf = [`fps=30`, `scale=1920:${1080 - BAR}:flags=lanczos`, `pad=1920:1080:0:0:color=0x141414`, `drawbox=x=0:y=${1080 - BAR}:w=1920:h=2:color=0x333a42:t=fill`, ...draw].join(",");
  sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", vf, "-t", total.toFixed(2), "-c:v", "libx264", "-crf", "17", "-preset", "slow", "-pix_fmt", "yuv420p", video]);
  const vdur = Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).trim());
  writeFileSync(path.join(OUT, `timeline-${CUT}.json`), JSON.stringify({ total, videoSeconds: vdur, marks, captions, vo1: vo1.seconds, vo2: vo2?.seconds ?? null, speed }, null, 2));
  console.log(`video: ${video}  (${vdur.toFixed(1)} s, ${frames.length} frames)`);

  // ---- mix: narration over music, music ducked under the voice -----------------------------
  const voIn: { file: string; at: number }[] = [{ file: vo1.file, at: marks["vo1"]! }];
  if (vo2) voIn.push({ file: vo2.file, at: marks["vo2"]! });
  MUSIC.forEach((music, idx) => {
    const name = path.basename(music).replace(/\.mp3$/i, "").slice(0, 28);
    const outFile = path.join(OUT, `demo-${CUT}s-track${idx + 1}.mp4`);
    const inputs = ["-i", video, "-i", path.resolve(music), ...voIn.flatMap((v) => ["-i", v.file])];
    const voLabels = voIn.map((_, i) => `[v${i}]`).join("");
    const voChain = voIn.map((v, i) => `[${i + 2}:a]adelay=${Math.round(v.at * 1000)}|${Math.round(v.at * 1000)},volume=1.0[v${i}]`).join(";");
    const fade = `afade=t=in:st=0:d=1.5,afade=t=out:st=${Math.max(0, vdur - 2.4).toFixed(2)}:d=2.4`;
    const filter = [
      `[1:a]atrim=0:${vdur.toFixed(2)},asetpts=PTS-STARTPTS,volume=0.42,${fade}[m]`,
      voChain,
      `${voLabels}amix=inputs=${voIn.length}:normalize=0,apad=whole_dur=${vdur.toFixed(2)},asplit=2[voA][voB]`,
      `[m][voA]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=450[md]`,
      `[md][voB]amix=inputs=2:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
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
