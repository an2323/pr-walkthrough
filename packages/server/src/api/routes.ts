/**
 * api/routes.ts — Express router for the PR Walkthrough API.
 *
 * Routes:
 *   GET  /api/walkthroughs/:owner/:repo/:number               — serve stored walkthrough JSON
 *   POST /api/analyze  { prUrl }                              — trigger analysis pipeline
 *   GET  /api/context/:owner/:repo/:number                    — read file lines from checkout
 *   GET  /api/audio/:owner/:repo/:number/:stepId/:n.mp3       — serve/generate TTS sentence
 */

import { Router, type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseHunks } from "@pr-walkthrough/shared";
import { splitSentences, sentenceHash, generateSentenceAudio } from "../tts/elevenlabs.js";
import { loadWalkthrough, saveWalkthrough } from "../storage.js";
import { createAnalyzer, CachedAnalyzer } from "../analyzer/index.js";
import { fetchPRMeta, parsePRUrl } from "../github/client.js";
import { prepareWorkspace } from "../git/workspace.js";
import { validate } from "../validation/index.js";

const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."); // repo root (src/api → 4 up)

const router = Router();

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

    const wt = await loadWalkthrough(owner, repo, num);
    if (!wt) {
      res.status(404).json({ error: `No walkthrough found for ${owner}/${repo}#${num}` });
      return;
    }
    res.json(wt);
  }
);

// ---------------------------------------------------------------------------
// POST /api/analyze  { prUrl: string }
// ---------------------------------------------------------------------------

router.post("/analyze", async (req: Request, res: Response): Promise<void> => {
  const { prUrl } = req.body as { prUrl?: string };
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

  const analyzerType = process.env.ANALYZER ?? "cached";

  // ------------------------------------------------------------------
  // cached mode — skip GitHub fetch and workspace prep entirely
  // ------------------------------------------------------------------
  if (analyzerType === "cached") {
    const cached = new CachedAnalyzer();
    // Build a minimal AnalyzerInput so CachedAnalyzer can locate the file.
    const minimalInput = {
      repoPath: "",
      baseSha: "",
      headSha: "",
      pr: {
        repo: `${owner}/${repo}`,
        number,
        title: "",
        url: prUrl,
        author: "",
        filesChanged: 0,
        additions: 0,
        deletions: 0,
        commitTitles: [],
      },
      hunks: [],
      diff: "",
    };
    try {
      await cached.analyze(minimalInput);
    } catch (err) {
      res.status(404).json({ error: String(err) });
      return;
    }
    const walkthroughUrl = `${req.protocol}://${req.get("host")}/api/walkthroughs/${owner}/${repo}/${number}`;
    res.json({ walkthroughUrl });
    return;
  }

  // ------------------------------------------------------------------
  // bob mode — full pipeline
  // ------------------------------------------------------------------
  try {
    const pr = await fetchPRMeta(owner, repo, number);
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const workspace = await prepareWorkspace(repoUrl, pr.headSha!, pr.baseSha!, number, GIT_CACHE_DIR);
    const diff = await workspace.diff();
    const hunks = parseHunks(diff);

    const analyzer = createAnalyzer();
    const input = {
      repoPath: workspace.repoPath,
      baseSha: pr.baseSha!,
      headSha: pr.headSha!,
      pr,
      hunks,
      diff,
    };
    const draft = await analyzer.analyze(input);

    const result = await validate(draft, input, workspace);
    if (!result.valid || !result.walkthrough) {
      console.warn(`[analyze] validation errors for ${owner}/${repo}#${number}:`, result.errors);
      // Still save what we have if the draft is usable (soft errors from coverage/verbatim).
      // Only hard schema errors should block saving.
    }

    const wt = result.walkthrough ?? {
      ...draft,
      hunks,
      coverage: { totalHunks: hunks.length, explained: 0, skipped: 0, uncoveredHunkIds: hunks.map(h => h.id) },
    };

    await saveWalkthrough(wt);
    const walkthroughUrl = `${req.protocol}://${req.get("host")}/api/walkthroughs/${owner}/${repo}/${number}`;
    res.json({ walkthroughUrl });
  } catch (err) {
    console.error("[analyze] error:", err);
    res.status(500).json({ error: String(err) });
  }
});

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

    // Derive the cache path for this repo.
    const repoName = `${owner}__${repo}`;
    const repoPath = path.join(GIT_CACHE_DIR, repoName);
    if (!existsSync(path.join(repoPath, ".git"))) {
      res.status(404).json({ error: `Repo checkout not found — run /api/analyze first` });
      return;
    }

    // Load the stored walkthrough to get the SHAs.
    const num = parseInt(number, 10);
    const wt = await loadWalkthrough(owner, repo, num);
    if (!wt) {
      res.status(404).json({ error: `No walkthrough for ${owner}/${repo}#${number}` });
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

    // Load walkthrough to get the step narration.
    const wt = await loadWalkthrough(owner, repo, num);
    if (!wt) {
      res.status(404).json({ error: `No walkthrough for ${owner}/${repo}#${num}` });
      return;
    }
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

    const sentence = sentences[sentenceIndex];
    const hash = sentenceHash(sentence, voiceId);
    const audioDir = path.join(ROOT, "data/audio", owner, repo, number);
    const outPath = path.join(audioDir, `${stepId}-${sentenceIndex}-${hash}.mp3`);

    // Pre-generated files are served even without a key; only new audio needs one.
    if (!existsSync(outPath) && !apiKey) {
      res.status(503).json({ error: "TTS not configured" });
      return;
    }

    try {
      await generateSentenceAudio(sentence, voiceId, apiKey, outPath);
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

export default router;
