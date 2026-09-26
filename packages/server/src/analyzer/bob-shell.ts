/**
 * bob-shell.ts — BobShellAnalyzer: runs `bob run --format stream-json` in a
 * read-only custom mode (with the `explore` sub-agent enabled) and extracts
 * the walkthrough from the event stream. On a validation failure it makes
 * one repair attempt via `--resume` before giving up.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Hunk, PullRequestMeta } from "@pr-walkthrough/shared";
import type { Analyzer, AnalyzerInput, WalkthroughDraft } from "./interface.js";
import { classifyHunks } from "./classify-hunks.js";
import { gitCommonDir, type RepoWorkspace } from "../git/workspace.js";
import { validate } from "../validation/index.js";
import { assertBudget, recordSpend } from "./budget.js";

const execFileAsync = promisify(execFile);

// Repo root = 4 levels up from packages/server/src/analyzer/
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const MODE_SLUG = "pr-walkthrough";

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

// ---------------------------------------------------------------------------
// writeSidecar — ported verbatim from bob-spike.ts
// ---------------------------------------------------------------------------

/**
 * Write `.walkthrough/` sidecar (base files, diff, commits) and the read-only
 * custom mode into the checkout.
 */
export async function writeSidecar(
  repoPath: string,
  pr: PullRequestMeta,
  diff: string,
  hunks: Hunk[]
): Promise<void> {
  const dir = path.join(repoPath, ".walkthrough");
  await mkdir(path.join(dir, "base"), { recursive: true });
  await writeFile(path.join(dir, "pr.diff"), diff);

  const log = await git(repoPath, [
    "log", "--reverse", "--format=## %s%n%n%b",
    `${pr.baseSha}..${pr.headSha}`,
  ]);
  await writeFile(path.join(dir, "commits.txt"), log);

  // Fill commitTitles and author into the pr object in-place (callers may read them back).
  pr.commitTitles = (
    await git(repoPath, ["log", "--reverse", "--format=%s", `${pr.baseSha}..${pr.headSha}`])
  ).split("\n").filter(Boolean);
  pr.author = (await git(repoPath, ["log", "-1", "--format=%an", pr.headSha!])).trim();

  for (const file of new Set(hunks.map((h) => h.file))) {
    try {
      const content = await git(repoPath, ["show", `${pr.baseSha}:${file}`]);
      await mkdir(path.dirname(path.join(dir, "base", file)), { recursive: true });
      await writeFile(path.join(dir, "base", file), content);
    } catch {
      // file was added by the PR — no base version
    }
  }

  // Read-only custom mode: file reading/search only, no edit, no shell.
  // `subagent` lets the main agent spawn the built-in `explore` sub-agent
  // (its own mode already has `groups: [read]`, so this adds no write access)
  // for parallel, cheaper (modelTier "explorer") code searches — see
  // docs/analyzer-prompt.md "How to investigate". Set BOB_SUBAGENTS=0 to
  // disable if a run needs to be strictly single-agent.
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

  // Keep sidecar files out of `git status`. `repoPath` may be a linked worktree
  // (its `.git` is a file, not a directory) — `info/exclude` is shared across all
  // worktrees and lives under the common git dir, so resolve that explicitly.
  // Idempotent: writeSidecar runs on every analysis of every PR sharing this repo.
  const excludePath = path.join(await gitCommonDir(repoPath), "info", "exclude");
  const existingExclude = await readFile(excludePath, "utf-8").catch(() => "");
  if (!existingExclude.includes(".walkthrough/")) {
    await appendFile(excludePath, "\n.walkthrough/\n.bob/\n");
  }
}

// ---------------------------------------------------------------------------
// fillPrompt — ported verbatim from bob-spike.ts
// ---------------------------------------------------------------------------

/**
 * Fill the analyzer-prompt.md template with PR metadata, hunk list,
 * the walkthrough.ts schema, and the golden example (without hunks/coverage/pr).
 */
export async function fillPrompt(pr: PullRequestMeta, hunks: Hunk[]): Promise<string> {
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
    baseSha: pr.baseSha!,
    title: pr.title,
    body: pr.body ?? "",
    commitTitles: pr.commitTitles.map((t) => `- ${t}`).join("\n  ") || "(none)",
    linkedIssues: "(none)",
    hunkList,
    walkthroughSchema: "```ts\n" + schema + "\n```",
    goldenExample: JSON.stringify(golden),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

// ---------------------------------------------------------------------------
// runBob — `--format stream-json`, optional `--resume` for repair
// ---------------------------------------------------------------------------

export interface BobRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  /** One parsed JSON value per NDJSON line (the raw line if it didn't parse). */
  events: unknown[];
  taskId?: string;
  sessionCost: number;
  toolCalls: number;
  subagents: number;
  /** From a `{"type":"error",...}` event, if any — e.g. "The task reached the cost limit". */
  errorMessage?: string;
}

/**
 * Best-effort summary over an unverified event stream: walks every event
 * looking for known field names (confirmed for `--format json`'s envelope;
 * assumed to carry over to `--format stream-json`'s events — adjust here if
 * a smoke run shows otherwise) rather than assuming one fixed final shape.
 */
/**
 * Confirmed against a real stream-json run: a sub-agent spawn appears as
 * `{"tool_name":"spawn_subagent", "parameters":{"name":"explore", ...}}` —
 * one such event per spawn, followed by its own `tool_result` event. There is
 * no persistent per-subagent id in the stream, so this counts spawns, not
 * distinct agents (fine: each `spawn_subagent` call is one sub-agent run).
 */
function summarizeEvents(events: unknown[]): Pick<BobRun, "taskId" | "sessionCost" | "toolCalls" | "subagents" | "errorMessage"> {
  let taskId: string | undefined;
  let sessionCost = 0;
  let toolCalls = 0;
  let subagents = 0;
  let errorMessage: string | undefined;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o["task_id"] === "string" && !taskId) taskId = o["task_id"] as string;
    if (typeof o["session_costs"] === "number") sessionCost = Math.max(sessionCost, o["session_costs"] as number);
    if (typeof o["tool_calls"] === "number") toolCalls = Math.max(toolCalls, o["tool_calls"] as number);
    if (o["tool_name"] === "spawn_subagent") subagents++;
    // Confirmed by a real --resume run: `--max-cost` is the TASK'S CUMULATIVE
    // spend, not a per-invocation budget — resuming with a cap already below
    // what the original run spent fails immediately with an event shaped
    // like {"type":"error","message":"The task reached the cost limit..."}.
    // Surface it, since it otherwise looks identical to a normal empty reply.
    if (o["type"] === "error" && typeof o["message"] === "string") errorMessage = o["message"] as string;
    Object.values(o).forEach(visit);
  };
  events.forEach(visit);
  return { taskId, sessionCost, toolCalls, subagents, errorMessage };
}

/**
 * Spawn `bob run --format stream-json` with the prompt on stdin.
 * Hard 10-minute process timeout (matches the plan's budget discipline).
 * Pass `resumeTaskId` to continue a previous session (repair pass) instead
 * of starting a fresh one — `--mode` is omitted then, since a resumed
 * session already has one.
 */
export function runBob(
  prompt: string,
  repoPath: string,
  maxCost: string,
  opts: { resumeTaskId?: string } = {}
): Promise<BobRun> {
  const subagentsEnabled = process.env.BOB_SUBAGENTS !== "0";
  // Confirmed empirically (a $0.02 direct CLI test): `--resume` does NOT read
  // a follow-up prompt from stdin — it silently replays the ORIGINAL
  // session's cached transcript and exits at $0. The follow-up must be a
  // trailing positional argument instead; stdin is closed empty in that case
  // so the process doesn't wait on it. Also confirmed: `--workspace` must be
  // the exact same string as the original run (no symlink resolution, e.g.
  // macOS's /tmp vs /private/tmp) or Bob rejects it as "does not belong to".
  const args = [
    "run", "--format", "stream-json",
    ...(opts.resumeTaskId ? ["--resume", opts.resumeTaskId] : ["--mode", MODE_SLUG]),
    "--workspace", repoPath, "--max-cost", maxCost,
    "--max-turns", process.env.MAX_TURNS ?? "40",
    "--disable-mcp", "--trust", "--accept-license",
    ...(subagentsEnabled ? [] : ["--disable-subagents"]),
    ...(opts.resumeTaskId ? [prompt] : []),
  ];
  console.log(`[bob-shell] $ bob ${args.slice(0, -1).join(" ")}${opts.resumeTaskId ? " <prompt as arg>" : ""}`);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("bob", args, { cwd: repoPath, env: process.env, timeout: 600_000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const events = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return line; }
        });
      resolve({ code, stdout, stderr, ms: Date.now() - started, events, ...summarizeEvents(events) });
    });
    child.stdin.end(opts.resumeTaskId ? "" : prompt);
  });
}

/** Resume a previous Bob Shell session to fix specific validation issues. */
export function repairBob(taskId: string, issues: string[], repoPath: string, maxCost: string): Promise<BobRun> {
  const prompt = [
    "The walkthrough JSON you returned failed validation. Fix ONLY the issues below and",
    "return the complete corrected JSON object again — same rules as before: no prose,",
    "no markdown fence, omit hunks/coverage/pr.",
    "",
    "Validation errors:",
    ...issues.map((e) => `- ${e}`),
  ].join("\n");
  return runBob(prompt, repoPath, maxCost, { resumeTaskId: taskId });
}

// ---------------------------------------------------------------------------
// extractJsonObject — ported verbatim from bob-spike.ts
// ---------------------------------------------------------------------------

/**
 * Find a balanced top-level JSON object in a string. With no `predicate`,
 * returns the first one that parses (original behaviour). With a
 * `predicate`, keeps scanning past objects that parse but don't satisfy it
 * (e.g. an unrelated tool-call payload that happens to appear earlier).
 */
export function extractJsonObject(text: string, predicate?: (v: unknown) => boolean): unknown | undefined {
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

// ---------------------------------------------------------------------------
// findWalkthrough / findWalkthroughInEvents
// ---------------------------------------------------------------------------

const isWalkthroughLike = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && "steps" in (v as object) && "graph" in (v as object);

/**
 * The shape of `bob run --format json` is not documented yet: collect every
 * string value in the envelope and look for the walkthrough inside them.
 */
export function findWalkthrough(envelope: unknown): Record<string, unknown> | undefined {
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

// Metadata fields every stream-json event carries — never part of the answer text.
const EVENT_METADATA_KEYS = new Set(["type", "role", "timestamp", "id"]);

/**
 * `--format stream-json` fallback: the walkthrough JSON arrives split across
 * many "message"/assistant events' `content` deltas (confirmed on a real run:
 * a 31KB answer came as ~2490 small fragments). Reassemble it by
 * concatenating each assistant event's non-metadata string field(s), in
 * order, then scan the result for a balanced object that looks like a
 * Walkthrough. Concatenating an event's OTHER fields too (`type`, `role`,
 * `timestamp`) was an earlier bug here — that junk lands between every
 * fragment and corrupts the JSON completely (confirmed: it produced ~4x the
 * expected text length and no parseable object at all).
 */
export function findWalkthroughInEvents(events: unknown[]): Record<string, unknown> | undefined {
  // Confirmed by a real stream-json run: a "message" event with role "user"
  // echoes the FULL prompt back — including the golden example, which itself
  // has "steps" and "graph" keys. Searching all events indiscriminately would
  // find that echoed few-shot example before ever reaching Bob's own answer.
  const assistantEvents = events.filter(
    (e) => !!e && typeof e === "object" && (e as Record<string, unknown>)["role"] === "assistant"
  );
  const direct = findWalkthrough(assistantEvents);
  if (direct) return direct;
  const text = assistantEvents
    .map((e) =>
      Object.entries(e as Record<string, unknown>)
        .filter(([k, v]) => !EVENT_METADATA_KEYS.has(k) && typeof v === "string")
        .map(([, v]) => v as string)
        .join("")
    )
    .join("");
  const found = extractJsonObject(text, isWalkthroughLike);
  return isWalkthroughLike(found) ? found : undefined;
}

// ---------------------------------------------------------------------------
// normalizeDraft — ported verbatim from bob-spike.ts
// ---------------------------------------------------------------------------

/**
 * Bob sometimes cites the sidecar path (`.walkthrough/base/<path>`) as the file of
 * a code block. Map it back to the repo path and mark the block as BASE.
 */
export function normalizeDraft(draft: Record<string, unknown>): number {
  let fixed = 0;
  for (const step of (draft.steps as Record<string, unknown>[]) ?? []) {
    const beats = (step.beats as { code?: { file: string; revision: string }[] }[]) ?? [];
    for (const beat of beats) {
      for (const block of beat.code ?? []) {
        if (block.file.startsWith(".walkthrough/base/")) {
          block.file = block.file.slice(".walkthrough/base/".length);
          block.revision = "base";
          fixed++;
        }
      }
    }
    // Bob sometimes writes an explanation into `minor` instead of a boolean
    // flag — e.g. `"minor": "Rename only; no behavioral change..."`, seen on
    // a real #8340 run. Coerce any truthy non-boolean value to `true` and
    // keep the explanation as a note, rather than failing schema validation
    // (or worse, spending a --resume repair) over a field that clearly meant
    // "yes, this is minor".
    if (typeof step.minor !== "boolean" && step.minor) {
      const note = typeof step.minor === "string" ? step.minor : undefined;
      step.minor = true;
      if (note) {
        const notes = Array.isArray(step.notes) ? (step.notes as string[]) : [];
        if (!notes.includes(note)) step.notes = [...notes, note];
      }
      fixed++;
    }
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// BobShellAnalyzer
// ---------------------------------------------------------------------------

export class BobShellAnalyzer implements Analyzer {
  constructor(
    private maxCost = process.env.MAX_COST ?? "8",
    private repairMaxCost = process.env.REPAIR_MAX_COST ?? "1"
  ) {}

  async analyze(input: AnalyzerInput): Promise<WalkthroughDraft> {
    const { repoPath, pr, hunks, diff } = input;
    const started = Date.now();

    console.log(`[bob-shell] analyzing PR #${pr.number} in ${repoPath}`);

    // Classify hunks: send only non-mechanical ones to the analyzer.
    const { prompt: promptHunks, skipped: autoSkipped } = classifyHunks(hunks);
    if (autoSkipped.length > 0) {
      console.log(`[bob-shell] auto-skipping ${autoSkipped.length} mechanical hunk(s) (tests/snapshots/lockfiles/…)`);
    }

    await writeSidecar(repoPath, pr, diff, promptHunks);
    const prompt = await fillPrompt(pr, promptHunks);
    await assertBudget(Number(this.maxCost));
    const run = await runBob(prompt, repoPath, this.maxCost);
    console.log(
      `[bob-shell] run finished in ${Math.round(run.ms / 1000)}s, exit=${run.code}, ` +
        `cost=$${run.sessionCost.toFixed(3)}, tools=${run.toolCalls}, subagents=${run.subagents}`
    );

    let draft = findWalkthroughInEvents(run.events);
    if (!draft) {
      await recordSpend({
        pr: pr.repo + "#" + pr.number, mode: "full", maxCost: Number(this.maxCost),
        actualCost: run.sessionCost, durationSec: Math.round(run.ms / 1000),
        toolCalls: run.toolCalls, subagents: run.subagents, repairs: 0,
        valid: false, notes: "no walkthrough found in output",
      });
      throw new Error(
        `BobShellAnalyzer: no walkthrough found in bob output. ` +
          `exit=${run.code}  stderr=${run.stderr.slice(0, 500)}`
      );
    }

    /** Apply the fixed-up transforms the backend always owns, regardless of which run produced the draft. */
    const assemble = (d: Record<string, unknown>): WalkthroughDraft => {
      const normalizedCount = normalizeDraft(d);
      if (normalizedCount > 0) {
        console.log(`[bob-shell] normalized ${normalizedCount} sidecar path(s)`);
      }
      if (autoSkipped.length > 0) {
        const existing = (d.skippedHunks as { hunkId: string; reason: string }[] | undefined) ?? [];
        d.skippedHunks = [...existing, ...autoSkipped];
      }
      return { ...d, pr } as unknown as WalkthroughDraft;
    };

    let result = assemble(draft);
    let totalCost = run.sessionCost;
    let toolCalls = run.toolCalls;
    let subagents = run.subagents;
    let repairs = 0;

    // Validate internally purely to decide whether a repair is worth attempting
    // (and to log an accurate "valid" column) — routes.ts validates again,
    // authoritatively, before persisting.
    const workspace: RepoWorkspace = {
      repoPath, baseSha: pr.baseSha!, headSha: pr.headSha!,
      readFile: (file, rev) =>
        rev === "base" ? git(repoPath, ["show", `${pr.baseSha}:${file}`]) : readFile(path.join(repoPath, file), "utf-8"),
      diff: async () => diff,
    };
    let check = await validate(result, input, workspace);
    await recordSpend({
      pr: pr.repo + "#" + pr.number, mode: "full", maxCost: Number(this.maxCost),
      actualCost: run.sessionCost, durationSec: Math.round(run.ms / 1000),
      toolCalls: run.toolCalls, subagents: run.subagents, repairs: 0, valid: check.valid,
    });

    // One repair attempt via --resume if the draft fails validation and Bob
    // gave us a task id to resume. This continues the SAME session (cheaper
    // and more accurate than a fresh analysis) rather than starting over.
    if (!check.valid && run.taskId) {
      // `--max-cost` on a `--resume` call is the TASK'S CUMULATIVE spend, not
      // a fresh per-invocation budget — confirmed by a real repair attempt
      // that failed instantly with "The task reached the cost limit" because
      // the cap was below what the original run had already spent. Must be
      // the original spend plus the actual repair allowance.
      const repairCap = (run.sessionCost + Number(this.repairMaxCost)).toFixed(2);
      console.log(`[bob-shell] validation failed (${check.errors.length} issue(s)) — one repair attempt via --resume ${run.taskId} (cumulative cap $${repairCap})`);
      await assertBudget(Number(this.repairMaxCost));
      const repairRun = await repairBob(run.taskId, check.errors.slice(0, 20), repoPath, repairCap);
      console.log(
        `[bob-shell] repair finished in ${Math.round(repairRun.ms / 1000)}s, exit=${repairRun.code}, cost=$${repairRun.sessionCost.toFixed(3)}` +
          (repairRun.errorMessage ? `, error: ${repairRun.errorMessage}` : "")
      );
      const repaired = findWalkthroughInEvents(repairRun.events);
      if (repaired) {
        draft = repaired;
        result = assemble(draft);
        repairs = 1;
        check = await validate(result, input, workspace);
      } else {
        console.warn("[bob-shell] repair run did not return a walkthrough — keeping the original (invalid) draft");
      }
      // repairRun.sessionCost is the TASK'S NEW cumulative total (it includes the
      // original run's spend, since --resume continues the same task) — only the
      // increment over the original run is genuinely new spend for our own ledger.
      const repairIncrement = Math.max(0, repairRun.sessionCost - run.sessionCost);
      await recordSpend({
        pr: pr.repo + "#" + pr.number, mode: "repair", maxCost: Number(this.repairMaxCost),
        actualCost: repairIncrement, durationSec: Math.round(repairRun.ms / 1000),
        toolCalls: repairRun.toolCalls, subagents: repairRun.subagents, repairs: 1, valid: check.valid,
        notes: repairRun.errorMessage ?? (repaired ? undefined : "no walkthrough in repair output"),
      });
      // Bob's own stats are cumulative per TASK (confirmed: a failed resume
      // attempt still reported the original run's exact tool_calls count) —
      // so repairRun.sessionCost/toolCalls already are the new grand totals,
      // not increments to add on top of run.sessionCost/toolCalls.
      totalCost = repairRun.sessionCost;
      toolCalls = repairRun.toolCalls;
      subagents = Math.max(subagents, repairRun.subagents);
    }

    const durationMs = Date.now() - started;
    (result as unknown as Record<string, unknown>).meta = {
      ...(draft.meta as object | undefined),
      analyzer: "bob-shell",
      generatedAt: new Date().toISOString(),
      durationMs,
      run: {
        costUsd: totalCost,
        maxCostUsd: Number(this.maxCost) + (repairs > 0 ? Number(this.repairMaxCost) : 0),
        durationMs,
        toolCalls,
        subagents,
        repairs,
        taskId: run.taskId,
      },
    };

    return result;
  }
}
