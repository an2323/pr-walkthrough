/**
 * fake-bob.test.ts — the rehearsal stand-in speaks the same stream as Bob: the real runBob,
 * parser and schema check read its output, for every injected fault.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findWalkthroughInEvents, runBob } from "./bob-shell.js";
import { withRehearsal, bobCommand } from "./bob-command.js";
import { checkQuality, criticalQualityWarnings, validateSchema } from "../validation/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../api/__fixtures__/excalidraw-10295.live.json");

const PR = JSON.parse(readFileSync(FIXTURE, "utf-8")).pr;
/** Schema errors of a draft once the backend has added `pr` (Bob never writes it). */
const schemaErrors = (d: unknown) => validateSchema(d ? { ...(d as object), pr: PR } : d).errors;

function answersDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fake-bob-"));
  writeFileSync(path.join(dir, "walkthrough.json"), readFileSync(FIXTURE));
  mkdirSync(path.join(dir, "verify"));
  writeFileSync(path.join(dir, "verify", "scenarios.json"), JSON.stringify([{ id: "a", file: "a.cjs", title: "A" }]));
  writeFileSync(path.join(dir, "verify", "a.cjs"), "console.log('{}')\n");
  writeFileSync(path.join(dir, "verify", "pw.cjs"), "// backend writes this\n");
  return dir;
}

async function analyse(plan?: string) {
  const dir = answersDir();
  return withRehearsal({ answersDir: dir, plan: plan ? `${plan},slow=0` : "slow=0" }, async () => {
    const run = await runBob("prompt", dir, "4.9");
    return { run, draft: findWalkthroughInEvents(run.events) };
  });
}

describe("fake-bob", () => {
  it("is only used inside a rehearsal", () => {
    expect(bobCommand().bin).toBe(process.env.BOB_BIN || "bob");
  });

  it("answers an analysis with a parseable, schema-valid, clean draft at $0", async () => {
    const { run, draft } = await analyse();
    expect(run.code).toBe(0);
    expect(run.sessionCost).toBe(0);
    expect(run.taskId).toBe("fake-analysis-1");
    expect(draft).toBeDefined();
    expect(schemaErrors(draft)).toEqual([]);
    expect(draft!.shots).toBeUndefined();
    expect(draft!.hunks).toBeUndefined();
  });

  it("analysis=critical → draft with a critical quality warning", async () => {
    const { draft } = await analyse("analysis=critical");
    const wt = { ...draft, hunks: [], coverage: undefined } as never;
    expect(criticalQualityWarnings(checkQuality(wt)).map((w) => w.code)).toContain("headline-too-long");
  });

  it("analysis=badjson → still recovered by the local JSON repair", async () => {
    const { run, draft } = await analyse("analysis=badjson");
    expect(run.stdout).toContain('\\"quoted\\"'.replace(/\\\\/g, "\\")); // the quote is inside a JSON string delta
    expect(draft).toBeDefined();
    expect(schemaErrors(draft)).toEqual([]);
  });

  it("analysis=invalid → a schema error the repair resume must fix", async () => {
    const { draft } = await analyse("analysis=invalid");
    expect(schemaErrors(draft).length).toBeGreaterThan(0);
  });

  it("analysis=nojson → no walkthrough at all", async () => {
    const { draft } = await analyse("analysis=nojson");
    expect(draft).toBeUndefined();
  });

  it("a repair resume answers clean even when the first answer was broken", async () => {
    const dir = answersDir();
    const run = await withRehearsal({ answersDir: dir, plan: "analysis=invalid,slow=0" }, () =>
      runBob("The walkthrough JSON you returned failed validation. Fix ONLY…", dir, "5.9", { resumeTaskId: "fake-analysis-1" })
    );
    expect(schemaErrors(findWalkthroughInEvents(run.events))).toEqual([]);
  });

  it("verifier writes the saved scenario scripts (not pw.cjs) into .walkthrough/verify", async () => {
    const dir = answersDir();
    const ws = mkdtempSync(path.join(os.tmpdir(), "fake-ws-"));
    const { execFileSync } = await import("node:child_process");
    await withRehearsal({ answersDir: dir, plan: "slow=0" }, async () => {
      const cmd = bobCommand();
      execFileSync(cmd.bin, [...cmd.preArgs, "run", "--format", "stream-json", "--mode", "pr-verifier", "--workspace", ws, "--max-cost", "2"], {
        env: { ...process.env, ...cmd.env },
        input: "prompt",
      });
    });
    const files = readdirSync(path.join(ws, ".walkthrough", "verify")).sort();
    expect(files).toEqual(["a.cjs", "scenarios.json"]);
    expect(existsSync(path.join(ws, ".walkthrough", "verify", "pw.cjs"))).toBe(false);
  });
});
