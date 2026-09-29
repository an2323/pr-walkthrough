/**
 * verify-smoke.ts — exercise the WHOLE screenshot/verification chain for $0.
 *
 * The paid verifier run (Bob, ≤$2) only pays off if everything around it works on this machine:
 * installing the app at BASE and HEAD, starting both dev servers, loading them, running the
 * repro script, capturing per-symptom frames, and ablation. This runs exactly those pipeline
 * functions with a repro script that already exists (written by an earlier confirmed run), and
 * never calls Bob — so a broken install, a dev server that won't start, a browser that can't
 * launch or a 40-minute ablation shows up here, not after money is spent.
 *
 *   # on the VM, inside the api container (files copied to /tmp/smoke first):
 *   pnpm exec tsx scripts/verify-smoke.ts --dir /tmp/smoke
 *
 * /tmp/smoke needs the scenario scripts and a scenarios.json (or a single legacy repro.cjs). pw.cjs is
 * regenerated here (a saved one carries the absolute Playwright path of the machine that wrote it).
 *
 * Options:  --base <sha> --head <sha>   (default: excalidraw#10295)
 *           SMOKE_UNITS=2               how many hunks to ablate (10 runs at most in production)
 */
import "../src/env.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { parseHunks } from "@pr-walkthrough/shared";

import { ablationHasSignal, runAblation } from "../src/verify/ablation.js";
import { confirmScenarios } from "../src/verify/repro-confirm.js";
import { loadScenarios } from "../src/verify/scenarios.js";
import { ensureInstalled, startApp, warmUp, type AppServer } from "../src/verify/app-servers.js";
import { recipeFor } from "../src/verify/recipes.js";
import { ensureWorktree, pruneWorktrees } from "../src/git/workspace.js";

const execFileAsync = promisify(execFile);

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const dir = path.resolve(arg("dir", "/tmp/smoke"));
const BASE = arg("base", "95ddc663392d94cd22a17a982dde5060849038de");
const HEAD = arg("head", "67926be60b32cd8e429f507c730597c91cdefe17");
const UNITS = Number(process.env.SMOKE_UNITS ?? 2);
const GIT_CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const mainPath = path.join(GIT_CACHE_DIR, "excalidraw__excalidraw");

const rows: { step: string; result: string; seconds: number; ok: boolean }[] = [];
const t0 = Date.now();

async function step<T>(name: string, fn: () => Promise<T>, describe: (v: T) => { ok: boolean; result: string }): Promise<T> {
  const started = Date.now();
  process.stdout.write(`… ${name}\n`);
  try {
    const value = await fn();
    const d = describe(value);
    rows.push({ step: name, result: d.result, seconds: Math.round((Date.now() - started) / 1000), ok: d.ok });
    console.log(`${d.ok ? "✓" : "✗"} ${name}: ${d.result} (${Math.round((Date.now() - started) / 1000)}s)`);
    return value;
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 300);
    rows.push({ step: name, result: `THREW: ${msg}`, seconds: Math.round((Date.now() - started) / 1000), ok: false });
    console.log(`✗ ${name}: THREW ${msg}`);
    throw err;
  }
}

async function main(): Promise<void> {
  const recipe = recipeFor("excalidraw", "excalidraw");
  if (!recipe) throw new Error("no excalidraw recipe");
  const found = await loadScenarios(dir);
  if (found.length === 0) throw new Error(`${dir} has no scenarios.json and no repro.cjs — copy the scenario scripts there first`);
  if (!existsSync(path.join(mainPath, ".git"))) throw new Error(`no clone at ${mainPath} — run one analysis first (it clones the repo)`);

  const out = path.join(dir, "out");
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(dir, "pw.cjs"),
    `const { chromium } = require(${JSON.stringify(createRequire(import.meta.url).resolve("playwright"))});\n` +
      `exports.chromium = chromium;\nexports.launch = (o = {}) => chromium.launch({ headless: true, ...o });\n`
  );

  console.log(`smoke: BASE ${BASE.slice(0, 8)}, HEAD ${HEAD.slice(0, 8)}, dir ${dir}, cache ${GIT_CACHE_DIR}`);
  await execFileAsync("df", ["-h", GIT_CACHE_DIR]).then((r) => console.log(r.stdout.trim().split("\n").pop()));

  const removed = await pruneWorktrees(mainPath, [BASE, HEAD]);
  if (removed.length) console.log(`pruned ${removed.length} old worktree(s): ${removed.map((r) => r.slice(0, 8)).join(", ")}`);

  const baseWt = await step("worktree BASE", () => ensureWorktree(mainPath, BASE), (p) => ({ ok: existsSync(p), result: p }));
  const headWt = await step("worktree HEAD", () => ensureWorktree(mainPath, HEAD), (p) => ({ ok: existsSync(p), result: p }));

  await step("install BASE (cold, or reuse if already there)", () => ensureInstalled(recipe, baseWt), (m) => ({ ok: true, result: m }));
  await step("install HEAD (copies BASE's node_modules)", () => ensureInstalled(recipe, headWt, { donor: baseWt }), (m) => ({ ok: true, result: m }));

  const servers: AppServer[] = [];
  try {
    const base = await step("start BASE dev server", () => startApp(recipe, baseWt), (s) => ({ ok: true, result: s.url }));
    servers.push(base);
    const head = await step("start HEAD dev server", () => startApp(recipe, headWt), (s) => ({ ok: true, result: s.url }));
    servers.push(head);

    for (const [label, s] of [["BASE", base], ["HEAD", head]] as const) {
      await step(`warm-up ${label}`, () => warmUp(s.url, { readySelector: recipe.readySelector }), (w) => ({ ok: true, result: `${Math.round(w.ms / 1000)}s to a rendered app` }));
    }

    const confirmed = await step(
      "scenarios: contract (true@BASE, false@HEAD) and visible difference",
      () => confirmScenarios({ verifyDir: dir, baseUrl: base.url, headUrl: head.url, frameDir: out, logDir: out }),
      (rs) => ({
        ok: rs.length > 0 && rs.every((r) => r.outcome.ok && r.visible),
        result: rs.map((r) => `${r.scenario.id}: ${r.outcome.ok ? (r.visible ? "ok, frames differ" : r.identical ? "ok but frames IDENTICAL" : "ok, no frames") : r.outcome.problem}`).join(" | ") || "no scenarios",
      })
    );
    for (const r of confirmed) console.log(`  ${r.scenario.id} frames → ${path.join(out, r.scenario.id + "-before.png")} / -after.png`);
  } finally {
    await Promise.all(servers.map((s) => s.stop()));
  }

  // Ablation, on the real diff between the two worktrees.
  const diff = (await execFileAsync("git", ["diff", `${BASE}...${HEAD}`], { cwd: headWt, maxBuffer: 64 * 1024 * 1024 })).stdout;
  const hunks = parseHunks(diff).filter((h) => !/\.(test|spec)\./.test(h.file)).slice(0, UNITS);
  console.log(`  ablation on ${hunks.length} of the PR's hunks (production runs up to 5 units = 10 runs)`);
  const ablation = await step(
    `ablation (${hunks.length} units, worktrees under wt/, node_modules copied from BASE)`,
    async () => runAblation({ mainPath, baseSha: BASE, diff, hunks, recipe, scenarios: (await loadScenarios(dir)).map((sc) => ({ id: sc.id, title: sc.title, path: path.join(dir, sc.file) })), onProgress: (m) => console.log(`    ${m}`) }),
    (a) => (a
      ? { ok: ablationHasSignal(a), result: a.runs.map((r) => `${r.mode}:${r.verdict}`).join(", ") }
      : { ok: true, result: "skipped (≤1 unit)" })
  );
  if (ablation) for (const r of ablation.runs) if (r.detail) console.log(`    ${r.mode} ${r.verdict}: ${r.detail}`);
}

main()
  .catch((err) => {
    console.error("smoke aborted:", err instanceof Error ? err.message : err);
  })
  .finally(async () => {
    const mem = process.memoryUsage();
    const total = Math.round((Date.now() - t0) / 1000);
    console.log("\n=== smoke summary ===");
    for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${String(r.seconds).padStart(4)}s  ${r.step} — ${r.result}`);
    console.log(`total ${total}s, this process rss ${(mem.rss / 1024 ** 2).toFixed(0)} MB`);
    const failed = rows.filter((r) => !r.ok).length;
    console.log(failed === 0 ? "ALL GREEN — safe to spend on the Bob verifier" : `${failed} step(s) failed — fix before spending`);
    process.exit(failed === 0 ? 0 : 1);
  });
