/**
 * analyze-pipeline.test.ts — every branch of the live pipeline, at $0.
 *
 * The stages each have their own unit tests; what broke on paid runs was the WIRING between them
 * (a revise whose rewrite skipped the quality repair; a repair that dropped backend-owned fields).
 * Here Bob, the verifier, ablation and storage are scripted per scenario, and every finished run is
 * held to the same invariants — whatever path it took:
 *
 *  - the job ends with exactly one `done` (or one `error` for a failed analysis), never silently;
 *  - what was saved last is the final walkthrough, and it passes the schema;
 *  - no critical quality warning survives when a repair was possible;
 *  - screenshots: either real evidence (pair / note) or a plain-words reason — never a silent gap;
 *  - frames, symptom cards and ablation verdicts the backend attached survive every Bob rewrite;
 *  - the cost in `done` equals what the scripted Bob sessions actually spent.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Ablation, Hunk, ProgressEvent, Walkthrough } from "@pr-walkthrough/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE: Walkthrough = JSON.parse(readFileSync(path.join(HERE, "__fixtures__/excalidraw-10295.live.json"), "utf-8"));
const QUALITY_REPAIR_MAX = 1; // QUALITY_REPAIR_MAX_COST default

// ---------------------------------------------------------------------------
// Scripted world
// ---------------------------------------------------------------------------

type BobAnswer = { draft?: Record<string, unknown>; cost: number } | { error: string; cost: number };

interface World {
  /** Draft the analysis returns (already assembled, like BobShellAnalyzer does). */
  analysis: (() => Record<string, unknown>) | Error;
  analysisCost: number;
  extraHunks: Hunk[];
  /** One entry per quality-repair resume, in order. */
  qualityRepairs: BobAnswer[];
  verifier: unknown | Error;
  ablation: Ablation | undefined | Error;
  contradicts: boolean;
  revise: ((wt: Walkthrough) => unknown) | Error;
  /** Fact check answer; undefined = "text matches" at $0. */
  factCheck?: ((wt: Walkthrough) => unknown) | Error;
  factCheckCalls: number;
  /** Narration voice outcome; undefined = voice not configured. */
  voice?: "ok" | "failed";
  // --- observed ---
  events: ProgressEvent[];
  completed?: { walkthroughUrl: string; qualityWarnings?: { code: string }[] };
  failed?: string;
  saves: string[];
  spent: number;
  ledger: number;
  qualityRepairCalls: number;
  verifierCalls: number;
}

const w = vi.hoisted(() => ({ world: undefined as unknown as World }));

vi.mock("./jobs.js", () => ({
  emitProgress: (_id: string, e: ProgressEvent) => w.world.events.push(e),
  completeJob: (_id: string, r: World["completed"]) => (w.world.completed = r),
  failJob: (_id: string, m: string) => (w.world.failed = m),
}));

vi.mock("node:fs/promises", async (orig) => ({
  ...(await orig<typeof import("node:fs/promises")>()),
  // progress.ndjson of a live run — not written from a test.
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock("../storage.js", () => ({
  loadWalkthrough: async () => null,
  saveWalkthrough: async (wt: Walkthrough) => {
    w.world.saves.push(JSON.stringify(wt));
    return "saved";
  },
}));

vi.mock("../blobs.js", () => ({ blobsEnabled: () => false, uploadBlob: vi.fn(), uploadDir: vi.fn() }));

vi.mock("../github/client.js", () => ({ fetchPRMeta: async () => ({ ...FIXTURE.pr }) }));

vi.mock("../git/workspace.js", () => ({
  prepareWorkspace: async () => ({
    repoPath: "/tmp/fake-checkout",
    baseSha: FIXTURE.pr.baseSha,
    headSha: FIXTURE.pr.headSha,
    readFile: async () => "",
    diff: async () => "fake diff",
  }),
  pruneWorktrees: async () => [],
}));

vi.mock("@pr-walkthrough/shared", async (orig) => ({
  ...(await orig<typeof import("@pr-walkthrough/shared")>()),
  parseHunks: () => [...FIXTURE.hunks, ...w.world.extraHunks],
}));

vi.mock("../analyzer/budget.js", () => ({
  assertBudget: async () => 0,
  recordSpend: async (row: { actualCost: number }) => {
    w.world.ledger += row.actualCost;
  },
}));

vi.mock("../analyzer/index.js", () => ({
  CachedAnalyzer: class {},
  createAnalyzer: () => ({
    analyze: async () => {
      const a = w.world.analysis;
      if (a instanceof Error) throw a;
      w.world.spent += w.world.analysisCost;
      return a();
    },
  }),
}));

vi.mock("../analyzer/bob-shell.js", async (orig) => ({
  ...(await orig<typeof import("../analyzer/bob-shell.js")>()),
  qualityRepairBob: async (taskId: string, _issues: string[], _repo: string, cap: string) => {
    const answer = w.world.qualityRepairs[w.world.qualityRepairCalls++];
    if (!answer) throw new Error("test: unexpected quality repair");
    w.world.spent += answer.cost;
    const sessionCost = Number(cap) - QUALITY_REPAIR_MAX + answer.cost; // cumulative, like Bob reports it
    const events =
      "draft" in answer && answer.draft
        ? [{ type: "message", role: "assistant", content: JSON.stringify(answer.draft) }]
        : [{ type: "error", message: "error" in answer ? answer.error : "no answer" }];
    return { code: 0, stdout: "", stderr: "", ms: 1000, events, sessionCost, toolCalls: 3, subagents: 0, taskId };
  },
}));

// Validation without a checkout: schema + coverage are what a rewrite can break here
// (verbatim/line checks are covered by validation.test.ts against real files).
vi.mock("../validation/index.js", async (orig) => {
  const real = await orig<typeof import("../validation/index.js")>();
  return {
    ...real,
    validate: async (draft: Record<string, unknown>, input: { hunks: Hunk[] }) => {
      const schema = real.validateSchema(draft);
      if (!schema.valid) return { valid: false, errors: schema.errors };
      const coverage = real.computeCoverage(draft as never, input.hunks);
      if (coverage.uncoveredHunkIds.length > 0) return { valid: false, errors: [`uncovered hunks: ${coverage.uncoveredHunkIds.join(", ")}`] };
      return { valid: true, errors: [], walkthrough: { ...draft, hunks: input.hunks, coverage } };
    },
  };
});

vi.mock("../verify/bob-verifier.js", () => ({
  canVerify: () => true,
  verifyShots: async () => {
    w.world.verifierCalls++;
    const v = w.world.verifier;
    if (v instanceof Error) throw v;
    w.world.spent += (v as { costUsd: number }).costUsd;
    return v;
  },
}));

vi.mock("../verify/ablation.js", async (orig) => ({
  ...(await orig<typeof import("../verify/ablation.js")>()),
  runAblation: async () => {
    const a = w.world.ablation;
    if (a instanceof Error) throw a;
    return a;
  },
}));

vi.mock("../verify/revise.js", () => ({
  ablationContradictsWalkthrough: () => w.world.contradicts,
  reviseFromAblation: async ({ walkthrough }: { walkthrough: Walkthrough }) => {
    const r = w.world.revise;
    if (r instanceof Error) throw r;
    const out = r(walkthrough) as { costUsd: number };
    w.world.spent += out.costUsd;
    return out;
  },
}));

vi.mock("../verify/fact-check.js", () => ({
  factCheck: async ({ walkthrough }: { walkthrough: Walkthrough }) => {
    w.world.factCheckCalls++;
    const f = w.world.factCheck;
    if (f instanceof Error) throw f;
    const prev = walkthrough.meta.run?.costUsd ?? 0;
    if (!f) return { status: "unchanged", costUsd: 0, sessionCost: prev };
    const out = f(walkthrough) as { costUsd: number };
    w.world.spent += out.costUsd;
    return { ...out, sessionCost: prev + out.costUsd };
  },
}));

vi.mock("../tts/voice-stage.js", () => ({
  voicingConfigured: () => !!w.world.voice,
  voiceWalkthrough: async () =>
    w.world.voice === "ok"
      ? { status: "ok", generated: 30, cached: 0, chars: 3000 }
      : { status: "failed", reason: "ElevenLabs TTS error 401: quota_exceeded" },
}));

const { runAnalyzeJob } = await import("./analyze-pipeline.js");
const { validateSchema, checkQuality, criticalQualityWarnings } = await import("../validation/index.js");
const { assembleDraft } = await import("../analyzer/assemble.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** What Bob's analysis returns: the fixture without anything the backend adds later. */
/** First sentences up to 60 words, with any "— wait, actually …" clause removed. */
function cleanNarration(text: string): string {
  const sentences = text.replace(/\s*—\s*wait,[^.]*\./gi, ".").split(/(?<=[.?!])\s+/);
  const out: string[] = [];
  for (const sn of sentences) {
    if ((out.join(" ") + " " + sn).split(/\s+/).length > 60) break;
    out.push(sn);
  }
  return out.join(" ") || sentences[0];
}

function bobDraft(mut?: (d: Walkthrough) => void): Record<string, unknown> {
  const d = clone(FIXTURE) as Partial<Walkthrough> & Record<string, unknown>;
  delete d.hunks;
  delete d.coverage;
  delete d.shots;
  delete d.verification;
  d.skippedHunks = [];
  for (const s of d.steps!) {
    delete s.evidence;
    if (s.visual?.type === "symptoms") s.visual.items = s.visual.items.map((i) => (typeof i === "string" ? i : i.text));
    // A clean answer under today's rules: the recorded #10295 run broke two of them (a self-correction
    // in s3, two steps over 75 words) — run-report.test.ts keeps that recording as the failing case.
    s.narration = cleanNarration(s.narration ?? "");
  }
  d.meta = { analyzer: "bob-shell", generatedAt: "2026-09-29T00:00:00Z", language: "en" } as Walkthrough["meta"];
  mut?.(d as Walkthrough);
  return d;
}

/** The analysis as BobShellAnalyzer hands it over: assembled, with meta.run. */
function analysisResult(cost: number, mut?: (d: Walkthrough) => void): () => Record<string, unknown> {
  return () => {
    const d = assembleDraft(bobDraft(mut), clone(FIXTURE.pr), [...FIXTURE.hunks, ...w.world.extraHunks]);
    d.meta = { ...(d.meta as object), run: { costUsd: cost, maxCostUsd: 4.9, durationMs: 1000, toolCalls: 10, subagents: 1, repairs: 0, taskId: "task-1" } };
    return d;
  };
}

const LONG_HEADLINE = "This headline is much too long for the reader and the voice to follow";
const withLongHeadline = (d: Walkthrough) => {
  d.steps[1].headline = LONG_HEADLINE;
};

const SYMPTOM_SRCS = new Map([
  [0, "symptom-0-annotated.png"],
  [1, "symptom-1-annotated.png"],
]);

function verifierOk(cost = 0.66): unknown {
  return {
    status: "ok",
    shots: clone(FIXTURE.shots),
    costUsd: cost,
    reproPath: "/app/data/verify/x/repro.cjs",
    symptomSrcs: SYMPTOM_SRCS,
    measures: { base: {}, head: {} },
    scenarios: [{ id: "sidebar-zindex", title: "t", path: "/x.cjs" }],
    facts: [{ id: "sidebar-mobile-menu", title: "Menu closes the sidebar", symptomIndex: 1, base: { inMenu: true }, head: { sidebarStillVisible: false } }],
  };
}

const ABLATION = clone(FIXTURE.verification!.ablation!) as Ablation;

/** A revise the way reviseFromAblation returns it: shots/verification copied, fresh cumulative run. */
function reviseOk(cost: number, mut?: (d: Walkthrough) => void) {
  return (prev: Walkthrough) => {
    const d = assembleDraft(bobDraft(mut), prev.pr, prev.hunks) as unknown as Walkthrough;
    d.hunks = prev.hunks;
    d.coverage = prev.coverage;
    d.shots = prev.shots;
    d.verification = prev.verification;
    d.meta = { ...d.meta, run: { ...prev.meta.run!, costUsd: (prev.meta.run?.costUsd ?? 0) + cost } };
    return { status: "ok", walkthrough: d, costUsd: cost, repairs: 0 };
  };
}

const TEST_HUNK: Hunk = {
  id: "packages/excalidraw/tests/sidebar.test.tsx#1",
  file: "packages/excalidraw/tests/sidebar.test.tsx",
  header: "@@ -0,0 +1,3 @@",
  added: 3,
  removed: 0,
} as Hunk;

function world(over: Partial<World>): World {
  return {
    analysis: analysisResult(1.8),
    analysisCost: 1.8,
    extraHunks: [],
    qualityRepairs: [],
    verifier: verifierOk(),
    ablation: ABLATION,
    contradicts: false,
    revise: new Error("test: revise not expected"),
    events: [],
    saves: [],
    spent: 0,
    ledger: 0,
    qualityRepairCalls: 0,
    verifierCalls: 0,
    factCheckCalls: 0,
    ...over,
  };
}

async function run(over: Partial<World>): Promise<{ final?: Walkthrough; world: World }> {
  w.world = world(over);
  await runAnalyzeJob("job-1", "excalidraw", "excalidraw", 10295, "https://example.test");
  const last = w.world.saves.at(-1);
  return { final: last ? (JSON.parse(last) as Walkthrough) : undefined, world: w.world };
}

// ---------------------------------------------------------------------------
// Invariants — the same for every finished run
// ---------------------------------------------------------------------------

function expectFinishedCleanly(final: Walkthrough | undefined, wd: World, opts: { allowCritical?: boolean } = {}): Walkthrough {
  expect(wd.failed).toBeUndefined();
  const terminal = wd.events.filter((e) => e.kind === "done" || e.kind === "error");
  expect(terminal.map((e) => e.kind)).toEqual(["done"]);
  expect(wd.events.at(-1)?.kind).toBe("done");
  expect(final).toBeDefined();
  const wt = final!;

  // Saved last == final, and it's a schema-valid walkthrough covering every hunk.
  expect(validateSchema(wt).errors).toEqual([]);
  expect(wt.coverage?.uncoveredHunkIds ?? []).toEqual([]);

  // Quality: nothing critical ships when a repair was available.
  const critical = criticalQualityWarnings(checkQuality(wt));
  if (!opts.allowCritical) expect(critical.map((c) => c.message)).toEqual([]);
  // The job reports exactly the warnings of what was saved.
  expect((wd.completed?.qualityWarnings ?? []).map((q) => q.code).sort()).toEqual(checkQuality(wt).map((q) => q.code).sort());

  // Screenshots: evidence or an honest reason, never a silent gap / placeholder.
  const v = wt.verification;
  expect(v).toBeDefined();
  if (v!.status === "passed") {
    expect(!!wt.shots || !!v!.shotsNote).toBe(true);
    expect(v!.skipReason).toBeUndefined();
  } else {
    expect(v!.skipReason?.length).toBeGreaterThan(5);
    expect(v!.skipReason).not.toMatch(/didn't finish/);
    expect(wt.shots).toBeUndefined();
  }

  // Meta is the backend's, not whatever Bob echoed.
  expect(wt.meta.run?.taskId).toBe("task-1");

  // Money: `done` reports what was actually spent.
  const done = wd.events.at(-1) as Extract<ProgressEvent, { kind: "done" }>;
  expect(done.costUsd).toBeCloseTo(wd.spent, 6);
  return wt;
}

function expectEvidenceKept(wt: Walkthrough): void {
  const symptoms = wt.steps.find((s) => s.visual?.type === "symptoms")!.visual as { items: { src?: string }[] };
  expect(symptoms.items.map((i) => i.src)).toEqual(["symptom-0-annotated.png", "symptom-1-annotated.png"]);
  expect(wt.shots?.by).toBe("bob-verifier");
  expect(wt.verification?.ablation).toBeDefined();
  const s3 = wt.steps.find((s) => s.hunkIds.includes("packages/excalidraw/css/styles.scss#1"))!;
  expect(s3.evidence).toEqual({ source: "ablation", verdict: "needed" });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("runAnalyzeJob — every path ends in a trustworthy result", () => {
  beforeEach(() => {
    process.env.ANALYZER = "bob";
    delete process.env.VERIFY_SHOTS;
    delete process.env.VERIFY_ABLATION;
    delete process.env.VERIFY_REVISE;
    delete process.env.VERIFY_QUALITY_REPAIR;
  });

  it("happy path: clean analysis, verifier frames + cards, ablation, no revise", async () => {
    const { final, world: wd } = await run({});
    const wt = expectFinishedCleanly(final, wd);
    expectEvidenceKept(wt);
    expect(wd.qualityRepairCalls).toBe(0);
  });

  it("critical warning in the first draft → one quality repair fixes it", async () => {
    const { final, world: wd } = await run({
      analysis: analysisResult(1.8, withLongHeadline),
      qualityRepairs: [{ draft: bobDraft(), cost: 0.14 }],
    });
    const wt = expectFinishedCleanly(final, wd);
    expect(wd.qualityRepairCalls).toBe(1);
    expect(wd.ledger).toBeCloseTo(0.14, 6);
    expectEvidenceKept(wt);
    expect(wt.meta.generatedAt).toBe("2026-09-29T00:00:00Z");
  });

  it("revise rewrites the steps with a critical warning and without the frames → repaired, evidence re-attached", async () => {
    const { final, world: wd } = await run({
      contradicts: true,
      revise: reviseOk(0.19, withLongHeadline),
      qualityRepairs: [{ draft: bobDraft(), cost: 0.12 }],
    });
    const wt = expectFinishedCleanly(final, wd);
    expect(wd.qualityRepairCalls).toBe(1);
    expectEvidenceKept(wt);
  });

  it("clean revise still keeps frames, cards and verdicts", async () => {
    const { final, world: wd } = await run({ contradicts: true, revise: reviseOk(0.19) });
    expectEvidenceKept(expectFinishedCleanly(final, wd));
    expect(wd.qualityRepairCalls).toBe(0);
  });

  it("PR with auto-skipped test hunks: a quality repair's answer (which never lists them) is accepted", async () => {
    const { final, world: wd } = await run({
      extraHunks: [TEST_HUNK],
      analysis: analysisResult(1.8, withLongHeadline),
      qualityRepairs: [{ draft: bobDraft(), cost: 0.14 }],
    });
    const wt = expectFinishedCleanly(final, wd);
    expect(wt.skippedHunks.map((s) => s.hunkId)).toContain(TEST_HUNK.id);
  });

  it("PR with auto-skipped hunks through revise + post-revise repair", async () => {
    const { final, world: wd } = await run({
      extraHunks: [TEST_HUNK],
      contradicts: true,
      revise: reviseOk(0.19, withLongHeadline),
      qualityRepairs: [{ draft: bobDraft(), cost: 0.12 }],
    });
    expectEvidenceKept(expectFinishedCleanly(final, wd));
  });

  it("quality repair returns nothing usable → keeps the draft, still counts the money", async () => {
    const { final, world: wd } = await run({
      analysis: analysisResult(1.8, withLongHeadline),
      qualityRepairs: [{ error: "The task reached the cost limit", cost: 0.05 }],
    });
    const wt = expectFinishedCleanly(final, wd, { allowCritical: true });
    expect(wt.steps[1].headline).toBe(LONG_HEADLINE);
    expect(wd.ledger).toBeCloseTo(0.05, 6);
  });

  it("verifier declines in plain words → shown as written, no ablation", async () => {
    const { final, world: wd } = await run({
      verifier: { status: "skipped", reason: "The change only affects keyboard focus, which a still image can't show.", costUsd: 0.3, kind: "declined" },
    });
    const wt = expectFinishedCleanly(final, wd);
    expect(wt.verification?.skipReason).toMatch(/keyboard focus/);
  });

  it("verifier fails (script never held) → plain reason, no frames", async () => {
    const { final, world: wd } = await run({
      verifier: { status: "skipped", reason: "repro not trusted: bug absent on BASE", costUsd: 1.2 },
    });
    const wt = expectFinishedCleanly(final, wd);
    expect(wt.verification?.skipReason).toMatch(/couldn't be reproduced/);
  });

  it("verifier throws (dev server died) → plain reason, run still finishes", async () => {
    const { final, world: wd } = await run({ verifier: new Error("yarn start exited with code 1") });
    const wt = expectFinishedCleanly(final, wd);
    expect(wt.verification?.status).toBe("skipped");
  });

  it("frames identical → honest note instead of a pair, ablation still measured", async () => {
    const v = verifierOk() as Record<string, unknown>;
    delete v.shots;
    v.shotsNote = "The bug was reproduced in the running app, but before and after look the same in a still image.";
    const { final, world: wd } = await run({ verifier: v });
    const wt = expectFinishedCleanly(final, wd);
    expect(wt.verification?.shotsNote).toMatch(/look the same/);
    expect(wt.verification?.ablation).toBeDefined();
  });

  it("ablation throws → frames kept, no verdicts invented", async () => {
    const { final, world: wd } = await run({ ablation: new Error("worktree add failed") });
    const wt = expectFinishedCleanly(final, wd);
    expect(wt.shots).toBeDefined();
    expect(wt.verification?.ablation).toBeUndefined();
    expect(wt.steps.every((s) => !s.evidence)).toBe(true);
  });

  it("revise fails → prior draft kept, its spend still reported", async () => {
    const { final, world: wd } = await run({
      contradicts: true,
      revise: () => {
        w.world.spent += 0; // counted below via costUsd
        return { status: "failed", reason: "no walkthrough JSON found", costUsd: 0.2 };
      },
    });
    expectEvidenceKept(expectFinishedCleanly(final, wd));
  });

  it("screenshots turned off → says so, no verifier call", async () => {
    process.env.VERIFY_SHOTS = "0";
    const { final, world: wd } = await run({});
    const wt = expectFinishedCleanly(final, wd);
    expect(wd.verifierCalls).toBe(0);
    expect(wt.verification?.skipReason).toMatch(/turned off/);
  });

  it("fact check corrects a sentence → frames, verdicts kept, cost counted, still no critical warnings", async () => {
    const { final, world: wd } = await run({
      factCheck: (prev) => {
        const out = JSON.parse(JSON.stringify(prev)) as Walkthrough;
        out.plain!.problem = "Opening the main menu left the sidebar open at the same time.";
        return { status: "ok", walkthrough: out, changed: ["plain.problem"], costUsd: 0.15 };
      },
    });
    const wt = expectFinishedCleanly(final, wd);
    expectEvidenceKept(wt);
    expect(wt.plain!.problem).toMatch(/at the same time/);
    expect(wd.factCheckCalls).toBe(1);
  });

  it("fact check only runs after a confirmed repro", async () => {
    const { final, world: wd } = await run({ verifier: { status: "skipped", reason: "repro not trusted", costUsd: 0.4 } });
    expectFinishedCleanly(final, wd);
    expect(wd.factCheckCalls).toBe(0);
  });

  it("fact check throws → run still finishes with the unchecked text", async () => {
    const { final, world: wd } = await run({ factCheck: new Error("bob exited") });
    expectEvidenceKept(expectFinishedCleanly(final, wd));
  });

  it("voice recorded as the last stage before done", async () => {
    const { final, world: wd } = await run({ voice: "ok" });
    expectFinishedCleanly(final, wd);
    const stages = wd.events.filter((e) => e.kind === "stage").map((e) => (e as { stage: string }).stage);
    expect(stages.at(-1)).toBe("voicing");
  });

  it("voice fails (quota) → run still finishes, says the browser voice will read it", async () => {
    const { final, world: wd } = await run({ voice: "failed" });
    expectFinishedCleanly(final, wd);
    const labels = wd.events.filter((e) => e.kind === "stage").map((e) => (e as { label: string }).label);
    expect(labels.at(-1)).toMatch(/browser voice/);
  });

  it("analysis throws → one error event, job failed, nothing saved", async () => {
    const { world: wd } = await run({ analysis: new Error("BobShellAnalyzer: no walkthrough found in bob output") });
    expect(wd.failed).toMatch(/couldn.t be read as a walkthrough/);
    expect(wd.events.filter((e) => e.kind === "done")).toEqual([]);
    expect(wd.events.at(-1)?.kind).toBe("error");
    expect(wd.saves).toEqual([]);
  });
});
