#!/usr/bin/env node
/**
 * fake-bob.mjs — a $0 stand-in for `bob run --format stream-json`, used by rehearsals
 * (src/analyzer/bob-command.ts). It takes the same arguments and prints the same kind of NDJSON
 * stream (the answer split into small assistant deltas, then a `result` event with stats), so
 * everything that parses, validates, repairs and renders Bob's output runs for real.
 *
 * Answers come from FAKE_BOB_ANSWERS:
 *   walkthrough.json   the walkthrough of the last real run of this PR (backend fields are stripped)
 *   verify/            the scenario scripts that run confirmed (copied to .walkthrough/verify/)
 *
 * FAKE_BOB_PLAN injects the failures seen on paid runs, comma-separated:
 *   analysis=critical   first answer has a 12-word headline → quality repair must fix it
 *   analysis=badjson    unescaped quote inside a string → local JSON repair must recover it
 *   analysis=invalid    a step without `narration` → schema repair resume
 *   analysis=nojson     prose only → the job must fail with a clear error
 *   verifier=broken     first script reports the bug on both builds → verifier repair resume
 *   verifier=skip       the verifier declines in plain words (skip.json)
 *   verifier=none       writes nothing → "no scenario script"
 *   quality=nojson      the quality repair answers with prose → draft kept, warning stays
 *   slow=<ms>           delay between deltas (default 2) — to watch the progress screen
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("fake-bob 1.0 (rehearsal)");
  process.exit(0);
}

const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = opt("--mode");
const resume = opt("--resume");
const workspace = opt("--workspace") ?? process.cwd();
const followUp = resume ? args[args.length - 1] : "";
const answers = process.env.FAKE_BOB_ANSWERS;
const plan = Object.fromEntries(
  (process.env.FAKE_BOB_PLAN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split("="))
);
const delay = Number(plan.slow ?? 2);

/** Which session / stage this call is. Resumed task ids carry the stage they were created in. */
const stage = resume
  ? resume.startsWith("fake-verifier")
    ? "verifier-repair"
    : /failed validation/.test(followUp)
      ? "repair"
      : /critical quality checks/.test(followUp)
        ? "quality"
        : "revise"
  : mode === "pr-verifier"
    ? "verifier"
    : "analysis";
const taskId = resume ?? (stage === "verifier" ? "fake-verifier-1" : "fake-analysis-1");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (e) => process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...e }) + "\n");

/** The walkthrough as Bob would write it: none of the fields the backend owns. */
function bobAnswer() {
  const wt = JSON.parse(readFileSync(path.join(answers, "walkthrough.json"), "utf-8"));
  for (const k of ["hunks", "coverage", "shots", "verification", "pr"]) delete wt[k];
  delete wt.meta?.run;
  for (const s of wt.steps ?? []) {
    delete s.evidence;
    if (s.visual?.type === "symptoms") s.visual.items = s.visual.items.map((i) => (typeof i === "string" ? i : i.text));
    for (const b of s.beats ?? []) for (const c of b.code ?? []) for (const l of c.lines ?? []) {
      delete l.n;
      delete l.change;
    }
  }
  // Mechanical hunks are added by the backend and never shown to Bob.
  wt.skippedHunks = (wt.skippedHunks ?? []).filter((s) => !/^(tests|snapshots|lockfile|translations|generated)\b/i.test(s.reason));
  return wt;
}

async function say(text) {
  for (let i = 0; i < text.length; i += 120) {
    emit({ type: "message", role: "assistant", content: text.slice(i, i + 120) });
    if (delay) await sleep(delay);
  }
}

async function tool(name, params) {
  emit({ type: "tool_use", tool_name: name, tool_id: `fake_${Math.random().toString(36).slice(2)}`, parameters: params });
  if (delay) await sleep(delay * 10);
  emit({ type: "tool_result", tool_id: "fake", status: "success" });
}

function finish(status = "success") {
  emit({ type: "result", status, stats: { task_id: taskId, duration_ms: 1000, session_costs: 0, max_cost: Number(opt("--max-cost") ?? 0), tool_calls: 2 } });
}

async function analysis() {
  emit({ type: "message", role: "user", content: "(rehearsal prompt)" });
  await tool("read_file", { path: path.join(workspace, ".walkthrough/pr.diff") });
  const wt = bobAnswer();
  const first = stage === "analysis";
  if (first && plan.analysis === "nojson") {
    await say("I looked at the pull request but I will describe it in prose instead of JSON.");
    return finish();
  }
  if (first && plan.analysis === "critical" && wt.steps?.[1]) {
    wt.steps[1].headline = "This headline is much too long for the reader and the voice to follow";
  }
  if (first && plan.analysis === "invalid" && wt.steps?.[0]) delete wt.steps[0].narration;
  if (stage === "quality" && plan.quality === "nojson") {
    await say("Sorry, I could not rewrite it.");
    return finish();
  }
  let text = "```json\n" + JSON.stringify(wt, null, 2) + "\n```";
  if (first && plan.analysis === "badjson") {
    // The failure of the 10:42 live run: an unescaped quote inside a prose string.
    text = text.replace(/("narration": ")([^"]{10})/, '$1$2 "quoted" ');
  }
  await say(text);
  finish();
}

function copyScripts(verifyDir) {
  const saved = path.join(answers, "verify");
  if (!existsSync(saved)) return 0;
  let n = 0;
  for (const f of readdirSync(saved)) {
    if (f === "pw.cjs" || !(f.endsWith(".cjs") || f === "scenarios.json")) continue;
    cpSync(path.join(saved, f), path.join(verifyDir, f));
    if (f.endsWith(".cjs")) n++;
  }
  return n;
}

async function verifier() {
  const verifyDir = path.join(workspace, ".walkthrough", "verify");
  mkdirSync(verifyDir, { recursive: true });
  emit({ type: "message", role: "user", content: "(rehearsal verifier prompt)" });
  if (stage === "verifier" && plan.verifier === "skip") {
    writeFileSync(path.join(verifyDir, "skip.json"), JSON.stringify({ skip: "Rehearsal: the verifier declined on purpose." }));
    await say("Declined.");
    return finish();
  }
  if (stage === "verifier" && plan.verifier === "none") {
    await say("I could not find a way to reproduce this.");
    return finish();
  }
  await tool("write_file", { path: path.join(verifyDir, "scenarios.json") });
  const n = copyScripts(verifyDir);
  if (stage === "verifier" && plan.verifier === "broken" && n > 0) {
    const scenarios = JSON.parse(readFileSync(path.join(verifyDir, "scenarios.json"), "utf-8"));
    const first = (Array.isArray(scenarios) ? scenarios : scenarios.scenarios)[0];
    // Bug "present" on both builds — breaks the contract, like the 12:09 live run.
    writeFileSync(path.join(verifyDir, first.file), `console.log(JSON.stringify({ bugPresent: true, measure: {}, highlights: [] }));\n`);
  }
  await say(n > 0 ? `Wrote ${n} scenario script(s).` : "No saved scenarios to rehearse with.");
  finish();
}

if (!answers || !existsSync(path.join(answers, "walkthrough.json"))) {
  process.stderr.write("fake-bob: FAKE_BOB_ANSWERS must contain walkthrough.json\n");
  emit({ type: "error", message: "rehearsal has no recorded answer" });
  process.exit(1);
}
await (stage === "verifier" || stage === "verifier-repair" ? verifier() : analysis());
