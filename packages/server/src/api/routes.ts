/**
 * api/routes.ts — Express router for the PR Walkthrough API.
 *
 * Routes:
 *   GET  /api/walkthroughs/:owner/:repo/:number               — serve stored walkthrough JSON
 *   GET  /api/recent?limit=N                                  — latest finished walkthroughs (landing page)
 *   POST /api/analyze  { prUrl, force? }                      — queue an analysis job, returns { jobId }
 *   GET  /api/jobs/:jobId                                     — current job status/result
 *   GET  /api/jobs/:jobId/events                              — SSE stream of ProgressEvents (live)
 *   GET|HEAD /api/runs/:owner/:repo/:number                   — does a recorded run exist? ($0 demo probe)
 *   GET  /api/runs/:owner/:repo/:number/events?speed=N         — SSE replay of a recorded run ($0 demo)
 *   GET  /api/context/:owner/:repo/:number                    — read file lines from checkout
 *   GET  /api/audio/:owner/:repo/:number/:stepId/:n.mp3       — serve/generate TTS sentence
 *   GET  /api/review/:owner/:repo/:number                     — can comments be posted, and where
 *   POST /api/review/:owner/:repo/:number/comments { body, anchor? } — post a comment to the demo PR
 */

import { Router, type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProgressEvent } from "@pr-walkthrough/shared";
import { splitSentences, sentenceHash, generateSentenceAudio, OUTRO_STEP_ID, OUTRO_NARRATION } from "../tts/elevenlabs.js";
import { listRecentWalkthroughs, loadRehearsal, loadWalkthrough } from "../storage.js";
import { fetchPRMeta, parsePRUrl } from "../github/client.js";
import { buildPreview, PreviewError } from "./preview.js";
import { enrichRecording } from "./recording-enrich.js";
import { resolveRecipe } from "../verify/recipes.js";
import { resolveTarget, postComment, type CommentAnchor } from "../github/review.js";
import { createJob, getJob, subscribeJob, findActiveJob, countJobsSince } from "./jobs.js";
import { runAnalyzeJob } from "./analyze-pipeline.js";
import { GuardError, adminKeyOk, assertAnalyzablePr, assertDailyLimit, dailyLimit } from "./guards.js";
import { blobExists, blobsEnabled, fetchBlobText, publicUrl, uploadBlob } from "../blobs.js";

/** Origin the browser used (behind Caddy: X-Forwarded-*). */
function publicBaseUrl(req: Request): string {
  const proto = (req.get("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
  const host = req.get("x-forwarded-host") ?? req.get("host");
  return `${proto}://${host}`;
}

const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos"; // used by /api/context to locate a PR's worktree
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."); // repo root (src/api → 4 up)

const router = Router();

/** Route-param safety shared by /runs and (in spirit) /context: no path traversal via owner/repo/number. */
function isSafePathSegment(s: string): boolean {
  return /^[\w.-]+$/.test(s) && s !== "." && s !== "..";
}

// GET /api/preview?pr=<github PR url> — what analysing this PR would give, before anyone presses the button.
// Free (our own store, or one cached GitHub lookup); never starts Bob. Light per-IP limit: it is public.
const previewHits = new Map<string, number[]>();
router.get("/preview", async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const recent = (previewHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 30) {
    res.status(429).json({ error: "Too many lookups — wait a minute" });
    return;
  }
  previewHits.set(ip, [...recent, now]);
  const pr = typeof req.query["pr"] === "string" ? req.query["pr"] : "";
  if (!pr) {
    res.status(400).json({ error: "pr is required" });
    return;
  }
  try {
    res.json(
      await buildPreview(pr, {
        parsePRUrl,
        loadWalkthrough,
        fetchPRMeta,
        canVerify: async (owner, repo) => !!(await resolveRecipe(owner, repo)),
      })
    );
  } catch (err) {
    if (err instanceof PreviewError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.warn("[preview] failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "Couldn't look that up just now" });
  }
});

// GET /api/recent — the latest finished walkthroughs, for the landing page's "Recent analyses".
router.get("/recent", async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await listRecentWalkthroughs(Number(req.query["limit"] ?? 12) || 12));
  } catch (err) {
    console.warn("[recent] could not list walkthroughs:", err instanceof Error ? err.message : err);
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// GET /api/walkthroughs/:owner/:repo/:number
// ---------------------------------------------------------------------------

router.get(
  "/walkthroughs/:owner/:repo/:number",
  async (req: Request, res: Response): Promise<void> => {
    const owner = req.params["owner"] as string;
    const repo = req.params["repo"] as string;
    const number = req.params["number"] as string;
    const num = parseInt(number, 10);
    if (isNaN(num)) {
      res.status(400).json({ error: "Invalid PR number" });
      return;
    }

    const wt = req.query["rehearsal"] ? await loadRehearsal(owner, repo, num) : await loadWalkthrough(owner, repo, num);
    if (!wt) {
      res.status(404).json({ error: `No walkthrough found for ${owner}/${repo}#${num}` });
      return;
    }
    res.json(wt);
  }
);

// ---------------------------------------------------------------------------
// POST /api/analyze  { prUrl: string }
//
// Returns { jobId } immediately (202) instead of blocking for the 3+ minutes
// a real Bob Shell run takes (ST6c) — the pipeline itself runs detached, in
// `runAnalyzeJob`, reporting progress through the job store. Poll
// GET /api/jobs/:jobId or stream GET /api/jobs/:jobId/events for the result.
// ---------------------------------------------------------------------------

router.get("/config", async (_req: Request, res: Response): Promise<void> => {
  const analyzer = process.env.ANALYZER ?? "cached";
  res.json({
    liveAnalysis: analyzer === "bob",
    dailyLimit: dailyLimit(),
    usedToday: analyzer === "bob" ? await countJobsSince(24 * 60 * 60 * 1000) : 0,
  });
});

/** True from the moment a paid run passes the "is anything running" check until its job exists. */
let startingPaidJob = false;

router.post("/analyze", async (req: Request, res: Response): Promise<void> => {
  const { prUrl } = (req.body ?? {}) as { prUrl?: string };
  if (!prUrl || typeof prUrl !== "string") {
    res.status(400).json({ error: "body.prUrl is required" });
    return;
  }

  let owner: string, repo: string, number: number;
  try {
    ({ owner, repo, number } = parsePRUrl(prUrl));
  } catch (err) {
    res.status(400).json({ error: String(err) });
    return;
  }

  // Cost guard: re-attach to a running job for the same PR; in bob mode allow
  // only one paid run at a time.
  const samePr = findActiveJob({ owner, repo, number });
  if (samePr) {
    res.status(202).json({ jobId: samePr.id });
    return;
  }

  const analyzer = process.env.ANALYZER ?? "cached";

  // Rehearsal ($0): the full pipeline with a fake Bob answering from this PR's last real result.
  // Access-code gated like a paid run (it occupies the machine for minutes), one job at a time.
  const rehearsalBody = (req.body as { rehearsal?: unknown; plan?: unknown }) ?? {};
  if (rehearsalBody.rehearsal === true) {
    const plan = typeof rehearsalBody.plan === "string" ? rehearsalBody.plan : undefined;
    if (plan !== undefined && !/^[a-z]+=[a-z0-9]+(,[a-z]+=[a-z0-9]+)*$/.test(plan)) {
      res.status(400).json({ error: "plan must look like analysis=critical,verifier=broken" });
      return;
    }
    if (!adminKeyOk(req)) {
      res.status(401).json({ error: "Rehearsals need the admin key" });
      return;
    }
    const busy = findActiveJob();
    if (busy || startingPaidJob) {
      res.status(409).json({ error: "Another analysis is running — try again when it finishes", ...(busy ? { jobId: busy.id } : {}) });
      return;
    }
    const job = createJob(owner, repo, number, { paid: false });
    void runAnalyzeJob(job.id, owner, repo, number, publicBaseUrl(req), { rehearsal: { plan } });
    res.status(202).json({ jobId: job.id, rehearsal: true });
    return;
  }

  const force = (req.body as { force?: unknown }).force === true && adminKeyOk(req);
  const alreadyDone = !force && (await loadWalkthrough(owner, repo, number)) !== null;

  // Everything below spends Bobcoins, so it is gated; an existing walkthrough is free to open.
  let reserved = false;
  if (analyzer === "bob" && !alreadyDone) {
    const busy = findActiveJob();
    // `startingPaidJob` closes the window between this check and createJob() below: the guards in
    // between await (daily count, GitHub), so two simultaneous POSTs used to both pass the
    // "nothing is running" check and start two paid runs.
    if (busy || startingPaidJob) {
      res.status(409).json({
        error: busy
          ? `Another analysis is running (${busy.owner}/${busy.repo}#${busy.number}) — try again when it finishes`
          : "Another analysis is starting — try again in a moment",
        ...(busy ? { jobId: busy.id } : {}),
      });
      return;
    }
    startingPaidJob = true;
    reserved = true;
    try {
      await assertDailyLimit(await countJobsSince(24 * 60 * 60 * 1000));
      await assertAnalyzablePr(owner, repo, number);
    } catch (err) {
      startingPaidJob = false;
      if (err instanceof GuardError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }

  const job = createJob(owner, repo, number, { paid: analyzer === "bob" && !alreadyDone });
  if (reserved) startingPaidJob = false; // the job itself now counts as "running"
  // Fire-and-forget: runAnalyzeJob catches all of its own errors and reports
  // them through the job store, so there is nothing left to await here.
  void runAnalyzeJob(job.id, owner, repo, number, publicBaseUrl(req), { force });

  res.status(202).json({ jobId: job.id });
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId — current status/result snapshot (polling fallback).
// ---------------------------------------------------------------------------

router.get("/jobs/:jobId", (req: Request, res: Response): void => {
  const job = getJob(req.params["jobId"] as string);
  if (!job) {
    res.status(404).json({ error: "Unknown job id" });
    return;
  }
  res.json({
    id: job.id,
    owner: job.owner,
    repo: job.repo,
    number: job.number,
    status: job.status,
    result: job.result,
    error: job.error,
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId/events — SSE stream of ProgressEvents.
//
// Sends the full backlog first (so a page reload/reconnect always sees
// everything that happened before it connected), then live events as they
// arrive. Closes the stream once a "done"/"error" event has been sent.
// ---------------------------------------------------------------------------

router.get("/jobs/:jobId/events", (req: Request, res: Response): void => {
  const job = getJob(req.params["jobId"] as string);
  if (!job) {
    res.status(404).json({ error: "Unknown job id" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering so SSE flushes immediately
  });

  let ended = false;
  const send = (e: ProgressEvent): void => {
    if (!ended) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  for (const e of job.events) send(e);

  if (job.status === "done" || job.status === "failed") {
    res.end();
    return;
  }

  const unsubscribe = subscribeJob(job.id, (e) => {
    send(e);
    if (e.kind === "done" || e.kind === "error") close();
  });
  const heartbeat = setInterval(() => {
    if (!ended) res.write(": heartbeat\n\n");
  }, 15_000);

  // Hoisted function declaration: safe to reference above before `unsubscribe`/
  // `heartbeat` are assigned, since `close` itself only ever runs later.
  function close(): void {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  }
  // `res` "close" = client went away (req "close" can fire as soon as the request body is read).
  res.on("close", close);
});

// ---------------------------------------------------------------------------
// GET|HEAD /api/runs/:owner/:repo/:number
// Cheap existence probe for a committed recording (used by the landing
// "Analyse →" button to prefer progress?replay=1 over skipping straight to
// the viewer when a finished walkthrough already exists).
// ---------------------------------------------------------------------------

function replayRecordingPath(owner: string, repo: string, number: string): string {
  return path.join(ROOT, "data/events", owner, repo, `${number}.ndjson`);
}

function replayRecordingKey(owner: string, repo: string, number: string): string {
  return `events/${owner}/${repo}/${number}.ndjson`;
}

/** Recording text from the local disk, else Supabase Storage; null when neither has it. */
async function readReplayRecording(owner: string, repo: string, number: string): Promise<string | null> {
  const local = replayRecordingPath(owner, repo, number);
  if (existsSync(local)) return readFile(local, "utf-8");
  return fetchBlobText(replayRecordingKey(owner, repo, number));
}

async function sendReplayProbe(req: Request, res: Response): Promise<void> {
  const owner = req.params["owner"] as string;
  const repo = req.params["repo"] as string;
  const number = req.params["number"] as string;
  if (!isSafePathSegment(owner) || !isSafePathSegment(repo) || !/^\d+$/.test(number)) {
    res.status(400).json({ error: "Invalid owner/repo/number" });
    return;
  }
  const exists =
    existsSync(replayRecordingPath(owner, repo, number)) ||
    (await blobExists(replayRecordingKey(owner, repo, number)));
  if (!exists) {
    res.status(404).json({ error: `No recorded run for ${owner}/${repo}#${number}` });
    return;
  }
  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }
  res.json({ owner, repo, number: parseInt(number, 10), hasReplay: true });
}

router.get("/runs/:owner/:repo/:number", sendReplayProbe);
router.head("/runs/:owner/:repo/:number", sendReplayProbe);

// ---------------------------------------------------------------------------
// GET /api/runs/:owner/:repo/:number/events?speed=N
//
// SSE replay of a committed recording (data/events/{owner}/{repo}/{number}.ndjson,
// produced offline by scripts/make-replay.ts) — demoable at $0, no Bob Shell
// process involved. `speed` multiplies playback rate; the default spreads
// the whole recording over ~20s regardless of how long the real run took.
// ---------------------------------------------------------------------------

const REPLAY_TARGET_MS = 20_000;

router.get(
  "/runs/:owner/:repo/:number/events",
  async (req: Request, res: Response): Promise<void> => {
    const owner = req.params["owner"] as string;
    const repo = req.params["repo"] as string;
    const number = req.params["number"] as string;
    if (!isSafePathSegment(owner) || !isSafePathSegment(repo) || !/^\d+$/.test(number)) {
      res.status(400).json({ error: "Invalid owner/repo/number" });
      return;
    }
    const num = parseInt(number, 10);

    let raw: string | null;
    try {
      raw = await readReplayRecording(owner, repo, number);
    } catch (err) {
      res.status(500).json({ error: `Could not read recording: ${String(err)}` });
      return;
    }
    if (raw === null) {
      res.status(404).json({ error: `No recorded run for ${owner}/${repo}#${num}` });
      return;
    }

    let events: ProgressEvent[];
    try {
      events = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ProgressEvent);
    } catch (err) {
      res.status(500).json({ error: `Could not read recording: ${String(err)}` });
      return;
    }

    // A recording made before the structured events existed plays on the current screen too: what it
    // lacks (the PR, the files, the scenario, the frames, the verdict) is read from that run's walkthrough.
    const finished = await loadWalkthrough(owner, repo, num).catch(() => null);
    const appCanRun = !!(await resolveRecipe(owner, repo).catch(() => undefined));
    events = enrichRecording(events, finished, appCanRun);

    const requestedSpeed = Number(req.query["speed"]);
    const totalMs = events.length > 0 ? events[events.length - 1].t : 0;
    const speed = requestedSpeed > 0 ? requestedSpeed : Math.max(1, totalMs / REPLAY_TARGET_MS);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Rewrite the recorded "done" event's URL to THIS server's own walkthrough
    // endpoint — the recording may have been made against a different host.
    const walkthroughUrl = `${publicBaseUrl(req)}/api/walkthroughs/${owner}/${repo}/${num}`;

    let ended = false;
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(): void {
      if (ended) return;
      ended = true;
      if (timer) clearTimeout(timer);
      res.end();
    }

    function sendNext(): void {
      if (ended || i >= events.length) {
        finish();
        return;
      }
      const e = events[i];
      const toSend = e.kind === "done" ? { ...e, walkthroughUrl } : e;
      res.write(`data: ${JSON.stringify(toSend)}\n\n`);
      const next = events[i + 1];
      i++;
      if (next) {
        timer = setTimeout(sendNext, Math.max(0, (next.t - e.t) / speed));
      } else {
        finish();
      }
    }

    res.on("close", finish);
    sendNext();
  }
);

// ---------------------------------------------------------------------------
// GET /api/context/:owner/:repo/:number
// Query params: file (required), rev ("base"|"head"), from (line), to (line)
// ---------------------------------------------------------------------------

router.get(
  "/context/:owner/:repo/:number",
  async (req: Request, res: Response): Promise<void> => {
    const owner = req.params["owner"] as string;
    const repo = req.params["repo"] as string;
    const number = req.params["number"] as string;
    const { file, rev = "head", from, to } = req.query as Record<string, string | undefined>;

    if (!file) {
      res.status(400).json({ error: "query param 'file' is required" });
      return;
    }

    // `file` comes from the client: it must stay inside the checkout.
    const safeFile = path.posix.normalize(file);
    if (path.isAbsolute(safeFile) || safeFile.startsWith("..") || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
      res.status(400).json({ error: "Invalid file path" });
      return;
    }

    // Load the stored walkthrough first — its headSha tells us which worktree to read.
    const num = parseInt(number, 10);
    const wt = await loadWalkthrough(owner, repo, num);
    if (!wt) {
      res.status(404).json({ error: `No walkthrough for ${owner}/${repo}#${number}` });
      return;
    }

    // Each PR gets its own git worktree (see git/workspace.ts) so concurrent
    // analyses of different PRs on the same repo don't share a working tree.
    const repoName = `${owner}__${repo}`;
    const repoPath = path.join(GIT_CACHE_DIR, repoName, "wt", wt.pr.headSha ?? "");
    if (!wt.pr.headSha || !existsSync(path.join(repoPath, ".git"))) {
      res.status(404).json({ error: `Repo checkout not found — run /api/analyze first` });
      return;
    }

    let content: string;
    try {
      if (rev === "base") {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync(
          "git", ["show", `${wt.pr.baseSha}:${safeFile}`],
          { cwd: repoPath, maxBuffer: 64 * 1024 * 1024 }
        );
        content = stdout;
      } else {
        content = await readFile(path.join(repoPath, safeFile), "utf-8");
      }
    } catch {
      res.status(404).json({ error: `File not found: ${file} at rev=${rev}` });
      return;
    }

    const lines = content.split("\n");
    const fromLine = from ? Math.max(1, parseInt(from, 10)) : 1;
    const toLine = to ? Math.min(lines.length, parseInt(to, 10)) : lines.length;
    const slice = lines.slice(fromLine - 1, toLine).join("\n");

    res.json({
      file,
      rev,
      from: fromLine,
      to: toLine,
      totalLines: lines.length,
      content: slice,
    });
  }
);

// ---------------------------------------------------------------------------
// GET /api/audio/:owner/:repo/:number/:stepId/:file
// :file must be "{sentenceIndex}.mp3"
// Serves pre-generated TTS mp3; generates on demand if missing.
// ---------------------------------------------------------------------------

router.get(
  "/audio/:owner/:repo/:number/:stepId/:file",
  async (req: Request, res: Response): Promise<void> => {
    const { owner, repo, number, stepId, file } = req.params as Record<string, string>;

    // Parse sentence index from "0.mp3", "1.mp3", …
    const match = /^(\d+)\.mp3$/.exec(file);
    if (!match) {
      res.status(400).json({ error: "Invalid audio filename — expected {n}.mp3" });
      return;
    }
    const sentenceIndex = parseInt(match[1], 10);
    const num = parseInt(number, 10);
    if (isNaN(num)) {
      res.status(400).json({ error: "Invalid PR number" });
      return;
    }

    const apiKey = process.env.ELEVENLABS_API_KEY ?? "";
    const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "";

    // Load walkthrough to get the step narration (or the Done-screen outro cue).
    const wt = await loadWalkthrough(owner, repo, num);
    if (!wt) {
      res.status(404).json({ error: `No walkthrough for ${owner}/${repo}#${num}` });
      return;
    }

    let sentence: string;
    if (stepId === OUTRO_STEP_ID) {
      if ((wt.graph?.nodes?.length ?? 0) === 0) {
        res.status(404).json({ error: "No diagram outro for this walkthrough" });
        return;
      }
      const sentences = splitSentences(OUTRO_NARRATION);
      if (sentenceIndex < 0 || sentenceIndex >= sentences.length) {
        res.status(404).json({ error: `Sentence index out of range (0–${sentences.length - 1})` });
        return;
      }
      sentence = sentences[sentenceIndex];
    } else {
      const step = wt.steps.find(s => s.id === stepId);
      if (!step) {
        res.status(404).json({ error: `Step not found: ${stepId}` });
        return;
      }
      const sentences = splitSentences(step.narration ?? "");
      if (sentenceIndex < 0 || sentenceIndex >= sentences.length) {
        res.status(404).json({ error: `Sentence index out of range (0–${sentences.length - 1})` });
        return;
      }
      sentence = sentences[sentenceIndex];
    }

    const hash = sentenceHash(sentence, voiceId);
    const fileName = `${stepId}-${sentenceIndex}-${hash}.mp3`;
    const audioDir = path.join(ROOT, "data/audio", owner, repo, number);
    const outPath = path.join(audioDir, fileName);
    const blobKey = `audio/${owner}/${repo}/${number}/${fileName}`;

    if (!existsSync(outPath) && (await blobExists(blobKey))) {
      res.redirect(302, publicUrl(blobKey));
      return;
    }

    // Pre-generated files are served even without a key. New audio costs
    // ElevenLabs credits, so it is only generated on demand with TTS_GENERATE=1
    // (otherwise the viewer falls back to Web Speech); `tts:pregen` is unaffected.
    if (!existsSync(outPath) && (!apiKey || process.env.TTS_GENERATE !== "1")) {
      res.status(503).json({ error: apiKey ? "On-demand TTS is off (set TTS_GENERATE=1)" : "TTS not configured" });
      return;
    }

    try {
      const fresh = !existsSync(outPath);
      await generateSentenceAudio(sentence, voiceId, apiKey, outPath);
      if (fresh && blobsEnabled()) {
        uploadBlob(blobKey, await readFile(outPath)).catch((err) =>
          console.warn("[audio] could not upload to Supabase Storage:", err instanceof Error ? err.message : err)
        );
      }
    } catch (err) {
      console.error("[audio] TTS generation failed:", err);
      res.status(502).json({ error: String(err) });
      return;
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(outPath).pipe(res);
  }
);

// ---------------------------------------------------------------------------
// GET  /api/review/:owner/:repo/:number
// POST /api/review/:owner/:repo/:number/comments  { body, anchor? }
//
// ST6d: comments go to the demo PR (github/review.ts), never upstream. Without
// GITHUB_TOKEN_WRITE the GET says { enabled: false } and the viewer falls back
// to copy-to-clipboard.
// ---------------------------------------------------------------------------

const MAX_COMMENT_CHARS = 10_000;

router.get("/review/:owner/:repo/:number", async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params as Record<string, string>;
  const wt = await loadWalkthrough(owner, repo, parseInt(number, 10));
  if (!wt) {
    res.status(404).json({ error: `No walkthrough for ${owner}/${repo}#${number}` });
    return;
  }
  const target = await resolveTarget(wt);
  if ("disabled" in target) {
    res.json({ enabled: false, reason: target.disabled });
    return;
  }
  res.json({ enabled: true, target: { repo: target.repo, number: target.number, url: target.url } });
});

function isAnchor(a: unknown): a is CommentAnchor {
  if (!a || typeof a !== "object") return false;
  const x = a as Record<string, unknown>;
  return (
    typeof x.file === "string" &&
    (x.revision === "base" || x.revision === "head" || x.revision === "diff") &&
    Array.isArray(x.lines) &&
    x.lines.length <= 500 &&
    x.lines.every((l) => l && typeof l === "object" && typeof (l as CommentAnchor["lines"][number]).text === "string" && typeof (l as CommentAnchor["lines"][number]).kind === "string") &&
    typeof x.index === "number" &&
    Number.isInteger(x.index) &&
    x.index >= 0 &&
    x.index < x.lines.length
  );
}

router.post("/review/:owner/:repo/:number/comments", async (req: Request, res: Response): Promise<void> => {
  const { owner, repo, number } = req.params as Record<string, string>;
  const { body, anchor } = (req.body ?? {}) as { body?: unknown; anchor?: unknown };
  if (typeof body !== "string" || !body.trim() || body.length > MAX_COMMENT_CHARS) {
    res.status(400).json({ error: `body must be a non-empty string up to ${MAX_COMMENT_CHARS} chars` });
    return;
  }
  if (anchor !== undefined && !isAnchor(anchor)) {
    res.status(400).json({ error: "Invalid anchor" });
    return;
  }

  const wt = await loadWalkthrough(owner, repo, parseInt(number, 10));
  if (!wt) {
    res.status(404).json({ error: `No walkthrough for ${owner}/${repo}#${number}` });
    return;
  }
  // The anchor's file must be one this PR touches — no probing arbitrary paths.
  if (anchor && !wt.hunks.some((h) => h.file === anchor.file)) {
    res.status(400).json({ error: `File not in this PR: ${anchor.file}` });
    return;
  }
  const target = await resolveTarget(wt);
  if ("disabled" in target) {
    res.status(503).json({ error: `Posting is off: ${target.disabled}` });
    return;
  }

  try {
    res.json(await postComment(target, body.trim(), anchor));
  } catch (err) {
    console.error("[review] posting failed:", err instanceof Error ? err.message : err);
    res.status(502).json({ error: "GitHub rejected the comment — see server log" });
  }
});

export default router;
