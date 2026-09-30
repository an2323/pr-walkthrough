import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProgressEvent, Walkthrough } from "@pr-walkthrough/shared";

import { enrichRecording } from "./recording-enrich.js";

const ROOT = new URL("../../../../", import.meta.url);
const recording = (p: string) => readFileSync(new URL(p, ROOT), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ProgressEvent);
const walkthrough = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), "utf-8")) as Walkthrough;

const kinds = (evs: ProgressEvent[]) => evs.map((e) => e.kind);
const stage = (t: number, stage: string, label: string): ProgressEvent => ({ kind: "stage", t, stage: stage as never, label });

const wt = (over: Partial<Walkthrough> = {}) =>
  ({
    pr: { repo: "a/b", number: 1, title: "fix: x", additions: 5, deletions: 2, filesChanged: 1 },
    hunks: [{ id: "f.ts#1", file: "f.ts", header: "@@", added: 5, removed: 2 }],
    skippedHunks: [],
    verification: { status: "passed", scenario: ["Open the menu", "Check it"] },
    shots: { by: "bob-verifier", before: { src: "before-annotated.png" }, after: { src: "after-annotated.png" }, caption: "c" },
    ...over,
  }) as unknown as Walkthrough;

const base = (): ProgressEvent[] => [
  stage(0, "clone", "Preparing"), stage(1000, "hunks", "1 hunks"), stage(1000, "analyzing", "Bob is analyzing"),
  { kind: "tool", t: 2000, tool: "read_file", target: "Reading f.ts" },
  stage(5000, "validating", "Validating"), stage(6000, "saving", "Saving"),
  stage(7000, "app", "Starting the app at BASE and HEAD"), stage(8000, "shots", "Bob is reproducing"),
  stage(20000, "shots", "Screenshots taken by Bob"), stage(21000, "shots", "Testing which changes fix the bug"),
  { kind: "done", t: 30000, walkthroughUrl: "/x", durationMs: 30000 },
];

describe("enrichRecording", () => {
  it("adds plan, files, scenario, then frames and the verdict where the pipeline would have", () => {
    const out = enrichRecording(base(), wt(), true);
    expect(kinds(out)).toEqual([
      "stage", "plan", "stage", "files", "stage", "tool", "stage", "scenario", "stage", "stage", "stage", "stage", "frames", "outcome", "stage", "done",
    ]);
    const plan = out.find((e) => e.kind === "plan")!;
    expect(plan).toMatchObject({ pr: { title: "fix: x", files: 1 }, shots: { planned: true } });
    expect(out.find((e) => e.kind === "frames")).toMatchObject({ before: "before-annotated.png", after: "after-annotated.png" });
    expect(out.find((e) => e.kind === "outcome")).toMatchObject({ code: "ok" });
    // time never goes backwards
    const ts = out.map((e) => e.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("a repository we cannot run: plan says why, the verdict is 'no-recipe'", () => {
    const events = [stage(0, "clone", "Preparing"), stage(1000, "hunks", "1 hunks"), stage(5000, "validating", "v"), stage(6000, "saving", "s"), { kind: "done", t: 9000, walkthroughUrl: "/x", durationMs: 9000 } as ProgressEvent];
    const w = wt({ shots: undefined, verification: { status: "skipped", scenario: [], skipReason: "this repository isn't set up for automatic screenshots." } });
    const out = enrichRecording(events, w, false);
    expect(out.find((e) => e.kind === "plan")).toMatchObject({ shots: { planned: false, reason: expect.stringMatching(/isn't set up/) } });
    expect(out.find((e) => e.kind === "scenario")).toBeUndefined();
    expect(out.find((e) => e.kind === "outcome")).toMatchObject({ code: "no-recipe" });
    expect(kinds(out).at(-1)).toBe("done");
  });

  it("reproduced but nothing to show → 'identical' with the note, no frames", () => {
    const w = wt({ shots: undefined, verification: { status: "passed", scenario: ["x"], shotsNote: "Same in a still." } });
    const out = enrichRecording(base(), w, true);
    expect(out.find((e) => e.kind === "frames")).toBeUndefined();
    expect(out.find((e) => e.kind === "outcome")).toMatchObject({ code: "identical", message: "Same in a still." });
  });

  it("a recording that already has a plan is returned untouched", () => {
    const events = enrichRecording(base(), wt(), true);
    expect(enrichRecording(events, wt(), true)).toBe(events);
  });

  it("no walkthrough, or an empty recording → nothing to add", () => {
    const events = base();
    expect(enrichRecording(events, null, true)).toBe(events);
    expect(enrichRecording([], wt(), true)).toEqual([]);
  });

  it("a recording without a screenshot stage puts the verdict just before the end", () => {
    const events = base().filter((e) => !(e.kind === "stage" && (e.stage === "app" || e.stage === "shots")));
    const out = enrichRecording(events, wt(), true);
    expect(kinds(out).slice(-3)).toEqual(["frames", "outcome", "done"]);
  });

  describe("real recordings of this repo", () => {
    it("the old #10295 recording plays with real files, scenario and frames", () => {
      const events = recording("data/events/excalidraw/excalidraw/10295.ndjson");
      const w = walkthrough("data/walkthroughs/excalidraw/excalidraw/10295.json");
      const out = enrichRecording(events, w, true);
      expect(out.length).toBeGreaterThan(events.length);
      const files = out.find((e) => e.kind === "files") as Extract<ProgressEvent, { kind: "files" }>;
      expect(files.files.length).toBeGreaterThan(0);
      expect(new Set(files.files.map((f) => f.path)).size).toBe(files.files.length);
      expect(kinds(out).indexOf("plan")).toBeLessThan(kinds(out).indexOf("files"));
      expect(kinds(out).at(-1)).toBe("done");
      expect(out.filter((e) => e.kind === "done")).toHaveLength(1);
    });
  });
});
