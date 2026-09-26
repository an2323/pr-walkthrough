/**
 * bob-shell.ts — BobShellAnalyzer: runs `bob run --format json` in a read-only
 * custom mode and extracts the walkthrough from the JSON envelope.
 *
 * Port of scripts/bob-spike.ts — functions ported verbatim; only the I/O wiring
 * and the class wrapper are new.
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
// runBob — ported verbatim from bob-spike.ts (without runDir writes)
// ---------------------------------------------------------------------------

interface BobRun { code: number | null; stdout: string; stderr: string; ms: number }

/**
 * Spawn `bob run --format json` with the prompt on stdin.
 * Hard 10-minute process timeout (matches the plan's budget discipline).
 */
export function runBob(
  prompt: string,
  repoPath: string,
  maxCost: string
): Promise<BobRun> {
  const args = [
    "run", "--format", "json", "--mode", MODE_SLUG,
    "--workspace", repoPath, "--max-cost", maxCost,
    "--max-turns", process.env.MAX_TURNS ?? "40",
    "--disable-mcp", "--trust", "--accept-license",
  ];
  console.log(`[bob-shell] $ bob ${args.join(" ")}`);
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
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(prompt);
  });
}

// ---------------------------------------------------------------------------
// extractJsonObject — ported verbatim from bob-spike.ts
// ---------------------------------------------------------------------------

/** Find the first balanced top-level JSON object in a string. */
export function extractJsonObject(text: string): unknown | undefined {
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

// ---------------------------------------------------------------------------
// findWalkthrough — ported verbatim from bob-spike.ts
// ---------------------------------------------------------------------------

/**
 * The shape of `bob run --format json` is not documented yet: collect every
 * string value in the envelope and look for the walkthrough inside them.
 */
export function findWalkthrough(envelope: unknown): Record<string, unknown> | undefined {
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

// ---------------------------------------------------------------------------
// normalizeDraft — ported verbatim from bob-spike.ts
// ---------------------------------------------------------------------------

/**
 * Bob sometimes cites the sidecar path (`.walkthrough/base/<path>`) as the file of
 * a code block. Map it back to the repo path and mark the block as BASE.
 */
export function normalizeDraft(draft: Record<string, unknown>): number {
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

// ---------------------------------------------------------------------------
// BobShellAnalyzer
// ---------------------------------------------------------------------------

export class BobShellAnalyzer implements Analyzer {
  constructor(private maxCost = process.env.MAX_COST ?? "8") {}

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
    const run = await runBob(prompt, repoPath, this.maxCost);

    const durationMs = Date.now() - started;
    console.log(`[bob-shell] finished in ${Math.round(durationMs / 1000)}s, exit=${run.code}`);

    let envelope: unknown;
    try { envelope = JSON.parse(run.stdout); } catch { envelope = run.stdout; }

    const draft = findWalkthrough(envelope);
    if (!draft) {
      throw new Error(
        `BobShellAnalyzer: no walkthrough found in bob output. ` +
          `exit=${run.code}  stderr=${run.stderr.slice(0, 500)}`
      );
    }

    const normalizedCount = normalizeDraft(draft);
    if (normalizedCount > 0) {
      console.log(`[bob-shell] normalized ${normalizedCount} sidecar path(s)`);
    }

    // Merge auto-skipped mechanical hunks into skippedHunks (coverage must be complete).
    if (autoSkipped.length > 0) {
      const existing = (draft.skippedHunks as { hunkId: string; reason: string }[] | undefined) ?? [];
      (draft as Record<string, unknown>).skippedHunks = [...existing, ...autoSkipped];
    }

    // Backend owns pr; inject it now.
    const result = { ...draft, pr } as unknown as WalkthroughDraft;
    // Backend also owns meta.generatedAt and durationMs.
    (result as unknown as Record<string, unknown>).meta = {
      ...(draft.meta as object | undefined),
      analyzer: "bob-shell",
      generatedAt: new Date().toISOString(),
      durationMs,
    };

    return result;
  }
}
