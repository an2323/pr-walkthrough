/**
 * bob-spike.ts — one-off Bob Shell spike on excalidraw/excalidraw#10295.
 *
 * Prototype of BobShellAnalyzer: prepares the checkout, fills the analyzer
 * prompt, runs `bob run` in a read-only custom mode, then validates the result
 * with the real validation pipeline. Everything is saved to data/runs/<stamp>/.
 *
 * Usage (from repo root, BOB_API_KEY exported):
 *   pnpm --filter @pr-walkthrough/server spike smoke     # ~trivial prompt, max 1 coin
 *   pnpm --filter @pr-walkthrough/server spike readonly  # asks Bob to write a file; must fail
 *   pnpm --filter @pr-walkthrough/server spike full      # real analysis, max-cost from MAX_COST (default 5)
 *   pnpm --filter @pr-walkthrough/server spike prepare   # checkout + prompt only, no Bob call
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseHunks, type Hunk, type PullRequestMeta } from "@pr-walkthrough/shared";
import type { AnalyzerInput, WalkthroughDraft } from "../src/analyzer/interface.js";
import type { RepoWorkspace } from "../src/git/workspace.js";
import { validate } from "../src/validation/index.js";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Project-level secrets (BOB_API_KEY, ...) live in the gitignored root .env.
if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
const CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const MODE_SLUG = "pr-walkthrough";

// excalidraw/excalidraw#10295 — "fix: close floating sidebar on main menu open"
const PR: PullRequestMeta = {
  repo: "excalidraw/excalidraw",
  number: 10295,
  title: "fix: close floating sidebar on main menu open",
  url: "https://github.com/excalidraw/excalidraw/pull/10295",
  author: "",
  baseSha: "95ddc663392d94cd22a17a982dde5060849038de",
  headSha: "67926be60b32cd8e429f507c730597c91cdefe17",
  filesChanged: 5,
  additions: 19,
  deletions: 7,
  commitTitles: [],
  body:
    "- move sidebar above top layer UI (especially top-right) so that buttons aren't above the sidebar when open\n" +
    "- close sidebar (when not docked) when opening main menu. This is necessary otherwise the previous change would make the main menu below the sidebar on mobile.",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Clone (blobless) and check out the PR head. Fork PR heads are not on any
 * upstream branch, so they must be fetched via refs/pull/N/head.
 */
async function prepareCheckout(): Promise<string> {
  const repoPath = path.join(CACHE_DIR, "excalidraw__excalidraw");
  if (!existsSync(path.join(repoPath, ".git"))) {
    await mkdir(CACHE_DIR, { recursive: true });
    await execFileAsync("git", [
      "clone", "--quiet", "--filter=blob:none", "--no-checkout",
      `https://github.com/${PR.repo}`, repoPath,
    ]);
  }
  await git(repoPath, ["fetch", "--quiet", "origin", `pull/${PR.number}/head`, PR.baseSha!]);
  await git(repoPath, ["checkout", "--detach", "--quiet", "--force", PR.headSha!]);
  return repoPath;
}

/** Everything Bob would otherwise need `git` for, written as plain files. */
async function writeSidecar(repoPath: string, diff: string, hunks: Hunk[]): Promise<void> {
  const dir = path.join(repoPath, ".walkthrough");
  await mkdir(path.join(dir, "base"), { recursive: true });
  await writeFile(path.join(dir, "pr.diff"), diff);

  const log = await git(repoPath, ["log", "--reverse", "--format=## %s%n%n%b", `${PR.baseSha}..${PR.headSha}`]);
  await writeFile(path.join(dir, "commits.txt"), log);
  PR.commitTitles = (await git(repoPath, ["log", "--reverse", "--format=%s", `${PR.baseSha}..${PR.headSha}`]))
    .split("\n").filter(Boolean);
  PR.author = (await git(repoPath, ["log", "-1", "--format=%an", PR.headSha!])).trim();

  for (const file of new Set(hunks.map((h) => h.file))) {
    try {
      const content = await git(repoPath, ["show", `${PR.baseSha}:${file}`]);
      await mkdir(path.dirname(path.join(dir, "base", file)), { recursive: true });
      await writeFile(path.join(dir, "base", file), content);
    } catch {
      // added by the PR — no base version
    }
  }

  // Read-only custom mode: file reading/search only, no edit, no shell.
  await mkdir(path.join(repoPath, ".bob"), { recursive: true });
  await writeFile(
    path.join(repoPath, ".bob", "custom_modes.yaml"),
    [
      "customModes:",
      `  - slug: ${MODE_SLUG}`,
      "    name: PR Walkthrough (read-only)",
      "    roleDefinition: >-",
      "      You are a senior engineer explaining a pull request to a reviewer.",
      "      You only read and search code; you never modify anything.",
      "    whenToUse: Analysing a pull request to produce a walkthrough JSON.",
      "    groups:",
      "      - read",
      "",
    ].join("\n")
  );

  // Keep sidecar files out of `git status` of the cached clone.
  await appendFile(path.join(repoPath, ".git", "info", "exclude"), "\n.walkthrough/\n.bob/\n");
}

async function fillPrompt(hunks: Hunk[]): Promise<string> {
  const template = (await readFile(path.join(ROOT, "docs/analyzer-prompt.md"), "utf-8"))
    .split("\n---\n").slice(1).join("\n---\n") // drop the doc header
    .replace(/[ \t]*<!--[\s\S]*?-->/g, "");
  const schema = await readFile(path.join(ROOT, "packages/shared/src/walkthrough.ts"), "utf-8");
  const golden = JSON.parse(
    await readFile(path.join(ROOT, "docs/bob-brief/examples/outline-13673.walkthrough.json"), "utf-8")
  );
  delete golden.hunks;
  delete golden.coverage;
  delete golden.pr;

  const hunkList = hunks
    .map((h) => `- ${h.id}  ${h.header}  +${h.added} -${h.removed}`)
    .join("\n  ");

  const vars: Record<string, string> = {
    repoPath: ".",
    baseSha: PR.baseSha!,
    title: PR.title,
    body: PR.body ?? "",
    commitTitles: PR.commitTitles.map((t) => `- ${t}`).join("\n  ") || "(none)",
    linkedIssues: "(none)",
    hunkList,
    walkthroughSchema: "```ts\n" + schema + "\n```",
    goldenExample: JSON.stringify(golden),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

interface BobRun { code: number | null; stdout: string; stderr: string; ms: number }

function runBob(prompt: string, repoPath: string, maxCost: string, runDir: string): Promise<BobRun> {
  const args = [
    "run", "--format", "json", "--mode", MODE_SLUG,
    "--workspace", repoPath, "--max-cost", maxCost, "--max-turns", process.env.MAX_TURNS ?? "40",
    "--disable-mcp", "--trust", "--accept-license",
  ];
  console.log(`$ bob ${args.join(" ")}  < prompt.md`);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("bob", args, { cwd: repoPath, env: process.env, timeout: 600_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      const run = { code, stdout, stderr, ms: Date.now() - started };
      await writeFile(path.join(runDir, "bob.stdout.txt"), stdout);
      await writeFile(path.join(runDir, "bob.stderr.txt"), stderr);
      resolve(run);
    });
    child.stdin.end(prompt);
  });
}

/** Find the first balanced top-level JSON object in a string. */
function extractJsonObject(text: string): unknown | undefined {
  const cleaned = text.replace(/```(?:json)?/g, "");
  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return undefined;
}

/**
 * The shape of `bob run --format json` is not documented yet: collect every
 * string value in the envelope and look for the walkthrough inside them.
 */
function findWalkthrough(envelope: unknown): Record<string, unknown> | undefined {
  const isWalkthrough = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && "steps" in (v as object) && "graph" in (v as object);
  const stack: unknown[] = [envelope];
  while (stack.length) {
    const v = stack.pop();
    if (isWalkthrough(v)) return v;
    if (typeof v === "string" && v.includes('"steps"')) {
      const parsed = extractJsonObject(v);
      if (isWalkthrough(parsed)) return parsed;
    } else if (v && typeof v === "object") {
      stack.push(...Object.values(v as object));
    }
  }
  return undefined;
}

/**
 * Bob sometimes cites the sidecar path (`.walkthrough/base/<path>`) as the file of
 * a code block. Map it back to the repo path and mark the block as BASE.
 */
function normalizeDraft(draft: Record<string, unknown>): number {
  let fixed = 0;
  for (const step of (draft.steps as { beats?: { code?: { file: string; revision: string }[] }[] }[]) ?? []) {
    for (const beat of step.beats ?? []) {
      for (const block of beat.code ?? []) {
        if (block.file.startsWith(".walkthrough/base/")) {
          block.file = block.file.slice(".walkthrough/base/".length);
          block.revision = "base";
          fixed++;
        }
      }
    }
  }
  return fixed;
}

async function validateDraft(
  draft: Record<string, unknown>, repoPath: string, diff: string, hunks: Hunk[],
  runDir: string, summary: Record<string, unknown>, durationMs?: number
): Promise<void> {
  summary.normalizedBlocks = normalizeDraft(draft);
  // The backend owns `pr`; the analyzer is told to omit it.
  const full = { ...draft, pr: PR } as unknown as WalkthroughDraft;
  const workspace: RepoWorkspace = {
    repoPath, baseSha: PR.baseSha!, headSha: PR.headSha!,
    readFile: (file, rev) =>
      rev === "base" ? git(repoPath, ["show", `${PR.baseSha}:${file}`]) : readFile(path.join(repoPath, file), "utf-8"),
    diff: async () => diff,
  };
  const input: AnalyzerInput = { repoPath, baseSha: PR.baseSha!, headSha: PR.headSha!, pr: PR, hunks, diff };
  const result = await validate(full, input, workspace);
  summary.valid = result.valid;
  summary.errorCount = result.errors.length;
  summary.errors = result.errors.slice(0, 30);
  if (result.walkthrough) {
    // Backend owns run metadata; the analyzer tends to invent `generatedAt`.
    result.walkthrough.meta = { ...result.walkthrough.meta, analyzer: "bob-shell", generatedAt: new Date().toISOString(), durationMs: durationMs ?? result.walkthrough.meta.durationMs };
    await writeFile(path.join(runDir, "walkthrough.json"), JSON.stringify(result.walkthrough, null, 2));
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "prepare";
  if (!["prepare", "smoke", "readonly", "full", "revalidate"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  if (!["prepare", "revalidate"].includes(mode) && !process.env.BOB_API_KEY) throw new Error("BOB_API_KEY is not set");

  const runDir = path.join(ROOT, "data/runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}`);
  await mkdir(runDir, { recursive: true });

  console.log("• preparing checkout", CACHE_DIR);
  const repoPath = await prepareCheckout();
  const diff = await git(repoPath, ["diff", `${PR.baseSha}...${PR.headSha}`]);
  const hunks = parseHunks(diff);
  await writeSidecar(repoPath, diff, hunks);
  console.log(`• ${hunks.length} hunks:`, hunks.map((h) => h.id).join(", "));

  if (mode === "revalidate") {
    // Re-check a saved draft without calling Bob: `spike revalidate <runDir>`.
    const src = path.resolve(process.argv[3] ?? "");
    const draft = JSON.parse(await readFile(path.join(src, "walkthrough.draft.json"), "utf-8"));
    const summary: Record<string, unknown> = { mode, source: src };
    await validateDraft(draft, repoPath, diff, hunks, src, summary);
    console.log("\n" + JSON.stringify(summary, null, 2));
    return;
  }

  const prompt =
    mode === "smoke"
      ? 'Reply with exactly this JSON and nothing else: {"ok":true}'
      : mode === "readonly"
        ? "Create a file named BOB_WRITE_TEST.txt in the workspace root containing the word hello. Then reply DONE."
        : await fillPrompt(hunks);
  await writeFile(path.join(runDir, "prompt.md"), prompt);
  console.log(`• prompt: ${prompt.length} chars → ${runDir}/prompt.md`);
  if (mode === "prepare") return;

  const maxCost = mode === "full" ? (process.env.MAX_COST ?? "5") : "1";
  const run = await runBob(prompt, repoPath, maxCost, runDir);

  let envelope: unknown;
  try { envelope = JSON.parse(run.stdout); } catch { envelope = run.stdout; }
  const summary: Record<string, unknown> = {
    mode,
    exitCode: run.code,
    durationSec: Math.round(run.ms / 1000),
    stdoutIsJson: typeof envelope !== "string",
    envelopeKeys: envelope && typeof envelope === "object" ? Object.keys(envelope) : undefined,
    // `bob run --format json` → { type, status, stats: { session_costs, tool_calls, ... }, last_message }
    status: (envelope as { status?: string })?.status,
    stats: (envelope as { stats?: unknown })?.stats,
    lastMessage: String((envelope as { last_message?: unknown })?.last_message ?? "").slice(0, 300),
  };

  if (mode === "readonly") {
    const written = existsSync(path.join(repoPath, "BOB_WRITE_TEST.txt"));
    summary.readOnlyHeld = !written;
  }

  if (mode === "full") {
    const draft = findWalkthrough(envelope);
    summary.walkthroughFound = !!draft;
    if (draft) {
      await writeFile(path.join(runDir, "walkthrough.draft.json"), JSON.stringify(draft, null, 2));
      await validateDraft(draft, repoPath, diff, hunks, runDir, summary, run.ms);
    }
  }

  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n" + JSON.stringify(summary, null, 2));
  console.log(`\nRecord Bobcoins before/after in docs/cost-log.md. Raw output: ${runDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
