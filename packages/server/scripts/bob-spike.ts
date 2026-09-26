/**
 * bob-spike.ts — Bob Shell testing tool for the "quality iteration" stage
 * (pr-walkthrough-plan.md). Prepares the checkout, fills the analyzer
 * prompt, runs `bob run` in a read-only custom mode (with the `explore`
 * sub-agent enabled), then validates the result with the real validation
 * pipeline. Everything is saved to data/runs/<stamp>/. Every paid mode goes
 * through the same $20 stage budget guard as the live server — see
 * src/analyzer/budget.ts and docs/cost-log-stage2.md.
 *
 * Usage (from repo root, BOB_API_KEY exported; PR=owner/repo#N selects the PR,
 * default excalidraw/excalidraw#10295):
 *   pnpm --filter @pr-walkthrough/server spike prepare        # checkout + prompt only, no Bob call, no cost
 *   pnpm --filter @pr-walkthrough/server spike smoke          # ~trivial prompt, max 1 coin
 *   pnpm --filter @pr-walkthrough/server spike smoke-subagent # spawns 2 explore sub-agents, max 1 coin
 *   pnpm --filter @pr-walkthrough/server spike readonly       # asks Bob to write a file; must fail
 *   pnpm --filter @pr-walkthrough/server spike full           # real analysis, max-cost from MAX_COST (default 5)
 *   pnpm --filter @pr-walkthrough/server spike repair <runDir>  # --resume a previous `full` run's task, fixing its errors
 *   pnpm --filter @pr-walkthrough/server spike revalidate <runDir>  # re-check a saved draft, no Bob call, no cost
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
import { prepareWorkspace, gitCommonDir } from "../src/git/workspace.js";
import { validate, checkQuality } from "../src/validation/index.js";
import { fetchPRMeta } from "../src/github/client.js";
import { classifyHunks } from "../src/analyzer/classify-hunks.js";
import { assertBudget, recordSpend } from "../src/analyzer/budget.js";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Project-level secrets (BOB_API_KEY, ...) live in the gitignored root .env.
if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
const CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const MODE_SLUG = "pr-walkthrough";

// Which PR to analyse: PR=owner/repo#number (default: excalidraw/excalidraw#10295).
// Metadata is fetched from GitHub; set GITHUB_TOKEN to avoid the anonymous rate limit.
const PR_REF = process.env.PR ?? "excalidraw/excalidraw#10295";
let PR: PullRequestMeta;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Prepare a git worktree for the PR head (shared clone + per-PR worktree —
 * see git/workspace.ts). Delegates entirely to `prepareWorkspace` so the
 * spike exercises the exact same checkout path the live server uses.
 */
async function prepareCheckout(): Promise<string> {
  const workspace = await prepareWorkspace(
    `https://github.com/${PR.repo}`, PR.headSha!, PR.baseSha!, PR.number, CACHE_DIR
  );
  return workspace.repoPath;
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
  // `subagent` lets the main agent spawn the built-in `explore` sub-agent
  // (its own mode is `groups: [read]`, so this adds no write access) for
  // parallel, cheaper code searches — see docs/analyzer-prompt.md. Set
  // BOB_SUBAGENTS=0 to test a strictly single-agent run.
  const subagentsEnabled = process.env.BOB_SUBAGENTS !== "0";
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
      ...(subagentsEnabled ? ["      - subagent"] : []),
      ...(subagentsEnabled ? ['    allowedSubagents: ["explore"]'] : []),
      "",
    ].join("\n")
  );

  // Keep sidecar files out of `git status`. `repoPath` is a linked worktree
  // (its `.git` is a file, not a directory) — `info/exclude` is shared across
  // all worktrees and lives under the common git dir. Idempotent: this runs
  // on every spike run against a repo that may already have the lines.
  const excludePath = path.join(await gitCommonDir(repoPath), "info", "exclude");
  const existingExclude = await readFile(excludePath, "utf-8").catch(() => "");
  if (!existingExclude.includes(".walkthrough/")) {
    await appendFile(excludePath, "\n.walkthrough/\n.bob/\n");
  }
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

interface BobRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  events: unknown[];
  taskId?: string;
  sessionCost: number;
  toolCalls: number;
  subagents: number;
}

/** Best-effort summary over an unverified event stream — see bob-shell.ts's twin. */
/**
 * Confirmed against a real stream-json run: a sub-agent spawn appears as
 * `{"tool_name":"spawn_subagent", "parameters":{"name":"explore", ...}}` —
 * one such event per spawn, followed by its own `tool_result` event. There is
 * no persistent per-subagent id in the stream, so this counts spawns, not
 * distinct agents (fine: each `spawn_subagent` call is one sub-agent run).
 */
function summarizeEvents(events: unknown[]): Pick<BobRun, "taskId" | "sessionCost" | "toolCalls" | "subagents"> {
  let taskId: string | undefined;
  let sessionCost = 0;
  let toolCalls = 0;
  let subagents = 0;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o["task_id"] === "string" && !taskId) taskId = o["task_id"] as string;
    if (typeof o["session_costs"] === "number") sessionCost = Math.max(sessionCost, o["session_costs"] as number);
    if (typeof o["tool_calls"] === "number") toolCalls = Math.max(toolCalls, o["tool_calls"] as number);
    if (o["tool_name"] === "spawn_subagent") subagents++;
    Object.values(o).forEach(visit);
  };
  events.forEach(visit);
  return { taskId, sessionCost, toolCalls, subagents };
}

/**
 * Spawn `bob run --format stream-json`. Pass `resumeTaskId` to continue a
 * previous session (repair pass) instead of starting a fresh one.
 */
function runBob(
  prompt: string, repoPath: string, maxCost: string, runDir: string,
  opts: { resumeTaskId?: string } = {}
): Promise<BobRun> {
  const subagentsEnabled = process.env.BOB_SUBAGENTS !== "0";
  const args = [
    "run", "--format", "stream-json",
    ...(opts.resumeTaskId ? ["--resume", opts.resumeTaskId] : ["--mode", MODE_SLUG]),
    "--workspace", repoPath, "--max-cost", maxCost, "--max-turns", process.env.MAX_TURNS ?? "40",
    "--disable-mcp", "--trust", "--accept-license",
    ...(subagentsEnabled ? [] : ["--disable-subagents"]),
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
      const events = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return line; }
        });
      const run: BobRun = { code, stdout, stderr, ms: Date.now() - started, events, ...summarizeEvents(events) };
      await writeFile(path.join(runDir, "bob.stdout.txt"), stdout);
      await writeFile(path.join(runDir, "bob.stderr.txt"), stderr);
      await writeFile(path.join(runDir, "events.ndjson"), events.map((e) => JSON.stringify(e)).join("\n"));
      resolve(run);
    });
    child.stdin.end(prompt);
  });
}

/**
 * Find a balanced top-level JSON object in a string. With no `predicate`,
 * returns the first one that parses. With a `predicate`, keeps scanning past
 * objects that parse but don't satisfy it (e.g. an unrelated tool-call
 * payload that happens to appear earlier in the text).
 */
function extractJsonObject(text: string, predicate?: (v: unknown) => boolean): unknown | undefined {
  const cleaned = text.replace(/```(?:json)?/g, "");
  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, i + 1));
          if (!predicate || predicate(parsed)) return parsed;
        } catch { /* not valid JSON at this start position — try the next one */ }
        break;
      }
    }
  }
  return undefined;
}

const isWalkthroughLike = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && "steps" in (v as object) && "graph" in (v as object);

/**
 * The shape of `bob run --format json` is not documented yet: collect every
 * string value in the envelope and look for the walkthrough inside them.
 */
function findWalkthrough(envelope: unknown): Record<string, unknown> | undefined {
  const stack: unknown[] = [envelope];
  while (stack.length) {
    const v = stack.pop();
    if (isWalkthroughLike(v)) return v;
    if (typeof v === "string" && v.includes('"steps"')) {
      const parsed = extractJsonObject(v);
      if (isWalkthroughLike(parsed)) return parsed;
    } else if (v && typeof v === "object") {
      stack.push(...Object.values(v as object));
    }
  }
  return undefined;
}

/**
 * `--format stream-json` fallback: if the walkthrough JSON is split across
 * several NDJSON events' text fragments, concatenate every string value from
 * every event in order and scan the result for a balanced object that looks
 * like a Walkthrough — see bob-shell.ts's twin for the full rationale.
 */
function findWalkthroughInEvents(events: unknown[]): Record<string, unknown> | undefined {
  // Confirmed by a real stream-json run: a "message" event with role "user"
  // echoes the FULL prompt back — including the golden example, which itself
  // has "steps" and "graph" keys. Searching all events indiscriminately would
  // find that echoed few-shot example before ever reaching Bob's own answer.
  const assistantEvents = events.filter(
    (e) => !!e && typeof e === "object" && (e as Record<string, unknown>)["role"] === "assistant"
  );
  const direct = findWalkthrough(assistantEvents);
  if (direct) return direct;
  let text = "";
  const visit = (v: unknown): void => {
    if (typeof v === "string") { text += v; return; }
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === "object") Object.values(v as object).forEach(visit);
  };
  assistantEvents.forEach(visit);
  const found = extractJsonObject(text, isWalkthroughLike);
  return isWalkthroughLike(found) ? found : undefined;
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

interface RunInfo {
  durationMs: number;
  sessionCost: number;
  maxCost: number;
  toolCalls: number;
  subagents: number;
  repairs: number;
  taskId?: string;
}

async function validateDraft(
  draft: Record<string, unknown>, repoPath: string, diff: string, hunks: Hunk[],
  runDir: string, summary: Record<string, unknown>, runInfo?: RunInfo
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
    result.walkthrough.meta = {
      ...result.walkthrough.meta,
      analyzer: "bob-shell",
      generatedAt: new Date().toISOString(),
      durationMs: runInfo?.durationMs ?? result.walkthrough.meta.durationMs,
      ...(runInfo && {
        run: {
          costUsd: runInfo.sessionCost, maxCostUsd: runInfo.maxCost, durationMs: runInfo.durationMs,
          toolCalls: runInfo.toolCalls, subagents: runInfo.subagents, repairs: runInfo.repairs, taskId: runInfo.taskId,
        },
      }),
    };
    const warnings = checkQuality(result.walkthrough);
    summary.qualityWarnings = warnings;
    if (warnings.length > 0) {
      console.log(`• ${warnings.length} quality warning(s) (see docs/output-contract.md):`, warnings.map((w) => w.code).join(", "));
    }
    await writeFile(path.join(runDir, "walkthrough.json"), JSON.stringify(result.walkthrough, null, 2));
  }
}

const MODES = ["prepare", "smoke", "smoke-subagent", "readonly", "full", "repair", "revalidate"];

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "prepare";
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode} (expected one of: ${MODES.join(", ")})`);
  if (!["prepare", "revalidate"].includes(mode) && !process.env.BOB_API_KEY) throw new Error("BOB_API_KEY is not set");

  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(PR_REF);
  if (!m) throw new Error(`PR must look like owner/repo#123, got ${PR_REF}`);
  PR = await fetchPRMeta(m[1], m[2], Number(m[3]));
  console.log(`• ${PR.repo}#${PR.number} — ${PR.title} (+${PR.additions} −${PR.deletions}, ${PR.filesChanged} files)`);

  const runDir = path.join(ROOT, "data/runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${PR.repo.split("/")[1]}-${PR.number}-${mode}`);
  await mkdir(runDir, { recursive: true });

  console.log("• preparing checkout", CACHE_DIR);
  const repoPath = await prepareCheckout();
  const diff = await git(repoPath, ["diff", `${PR.baseSha}...${PR.headSha}`]);
  const hunks = parseHunks(diff);
  const { prompt: promptHunks, skipped: autoSkipped } = classifyHunks(hunks);
  if (autoSkipped.length > 0) {
    console.log(`• auto-skipping ${autoSkipped.length} mechanical hunk(s):`, autoSkipped.map((s) => `${s.hunkId}(${s.reason})`).join(", "));
  }
  await writeSidecar(repoPath, diff, promptHunks);
  console.log(`• ${promptHunks.length} prompt hunks (${hunks.length} total):`, promptHunks.map((h) => h.id).join(", "));

  if (mode === "revalidate") {
    // Re-check a saved draft without calling Bob: `spike revalidate <runDir>`.
    const src = path.resolve(process.argv[3] ?? "");
    const draft = JSON.parse(await readFile(path.join(src, "walkthrough.draft.json"), "utf-8"));
    const summary: Record<string, unknown> = { mode, source: src };
    await validateDraft(draft, repoPath, diff, hunks, src, summary);
    console.log("\n" + JSON.stringify(summary, null, 2));
    return;
  }

  if (mode === "repair") {
    // `spike repair <runDir>` — continue a previous `full` run's Bob Shell
    // session via --resume, asking it to fix exactly the errors that run's
    // validateDraft recorded. Requires the same PR= env var as that run.
    const src = path.resolve(process.argv[3] ?? "");
    const prevSummary = JSON.parse(await readFile(path.join(src, "summary.json"), "utf-8"));
    const taskId = prevSummary.taskId as string | undefined;
    if (!taskId) throw new Error(`No taskId in ${src}/summary.json — nothing to resume`);
    const issues: string[] = prevSummary.errors ?? [];
    const prompt = [
      "The walkthrough JSON you returned failed validation. Fix ONLY the issues below and",
      "return the complete corrected JSON object again — same rules as before: no prose,",
      "no markdown fence, omit hunks/coverage/pr.",
      "",
      "Validation errors:",
      ...issues.map((e) => `- ${e}`),
    ].join("\n");
    await writeFile(path.join(runDir, "prompt.md"), prompt);
    console.log(`• resuming task ${taskId} to fix ${issues.length} issue(s)`);
    const maxCost = process.env.MAX_COST ?? "1";
    await assertBudget(Number(maxCost));
    const run = await runBob(prompt, repoPath, maxCost, runDir, { resumeTaskId: taskId });
    const draft = findWalkthroughInEvents(run.events);
    const summary: Record<string, unknown> = {
      mode, resumedFrom: src, exitCode: run.code, durationSec: Math.round(run.ms / 1000),
      taskId: run.taskId, sessionCost: run.sessionCost, toolCalls: run.toolCalls, subagents: run.subagents,
      walkthroughFound: !!draft,
    };
    if (draft) {
      await writeFile(path.join(runDir, "walkthrough.draft.json"), JSON.stringify(draft, null, 2));
      await validateDraft(draft, repoPath, diff, hunks, runDir, summary, {
        durationMs: run.ms, sessionCost: run.sessionCost, maxCost: Number(maxCost),
        toolCalls: run.toolCalls, subagents: run.subagents, repairs: 1, taskId: run.taskId,
      });
    }
    await recordSpend({
      pr: `${PR.repo}#${PR.number}`, mode: "repair", maxCost: Number(maxCost), actualCost: run.sessionCost,
      durationSec: Math.round(run.ms / 1000), toolCalls: run.toolCalls, subagents: run.subagents, repairs: 1,
      valid: summary.valid as boolean | undefined,
    });
    await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log("\n" + JSON.stringify(summary, null, 2));
    return;
  }

  const prompt =
    mode === "smoke"
      ? 'Reply with exactly this JSON and nothing else: {"ok":true}'
      : mode === "smoke-subagent"
        ? 'Spawn two "explore" sub-agents IN PARALLEL: one to find every call site of `useOutsideClick`, another to find every reference to `data-prevent-outside-click`. Wait for both to finish, then reply with exactly this JSON and nothing else: {"ok":true}'
        : mode === "readonly"
          ? "Create a file named BOB_WRITE_TEST.txt in the workspace root containing the word hello. Then reply DONE."
          : await fillPrompt(promptHunks);
  await writeFile(path.join(runDir, "prompt.md"), prompt);
  console.log(`• prompt: ${prompt.length} chars → ${runDir}/prompt.md`);
  if (mode === "prepare") return;

  const maxCost = mode === "full" ? (process.env.MAX_COST ?? "5") : "1";
  await assertBudget(Number(maxCost));
  const run = await runBob(prompt, repoPath, maxCost, runDir);

  const summary: Record<string, unknown> = {
    mode,
    exitCode: run.code,
    durationSec: Math.round(run.ms / 1000),
    eventCount: run.events.length,
    taskId: run.taskId,
    sessionCost: run.sessionCost,
    toolCalls: run.toolCalls,
    subagents: run.subagents,
  };

  if (mode === "readonly") {
    const written = existsSync(path.join(repoPath, "BOB_WRITE_TEST.txt"));
    summary.readOnlyHeld = !written;
  }

  if (mode === "smoke-subagent") {
    summary.subagentsUsed = run.subagents > 0;
  }

  if (mode === "full") {
    const draft = findWalkthroughInEvents(run.events);
    summary.walkthroughFound = !!draft;
    if (draft) {
      await writeFile(path.join(runDir, "walkthrough.draft.json"), JSON.stringify(draft, null, 2));
      await validateDraft(draft, repoPath, diff, hunks, runDir, summary, {
        durationMs: run.ms, sessionCost: run.sessionCost, maxCost: Number(maxCost),
        toolCalls: run.toolCalls, subagents: run.subagents, repairs: 0, taskId: run.taskId,
      });
    }
  }

  await recordSpend({
    pr: `${PR.repo}#${PR.number}`, mode, maxCost: Number(maxCost), actualCost: run.sessionCost,
    durationSec: Math.round(run.ms / 1000), toolCalls: run.toolCalls, subagents: run.subagents, repairs: 0,
    valid: mode === "full" ? (summary.valid as boolean | undefined) : undefined,
  });

  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n" + JSON.stringify(summary, null, 2));
  console.log(`\nSee docs/cost-log-stage2.md for cumulative stage spend. Raw output: ${runDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
