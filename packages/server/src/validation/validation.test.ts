/**
 * validation.test.ts — integration tests for the validation pipeline.
 *
 * Requires the outline/outline repo to be cloned at
 * /tmp/pr-walkthrough-repos/outline__outline (done by ST3).
 *
 * All tests use the golden JSON at
 * docs/bob-brief/examples/outline-13673.walkthrough.json.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { WalkthroughDraft, AnalyzerInput } from "../analyzer/interface.js";
import type { Hunk } from "@pr-walkthrough/shared";
import { validate } from "./index.js";
import { validateSchema } from "./schema.js";
import { computeCoverage } from "./coverage.js";
import { prepareWorkspace } from "../git/workspace.js";
import type { RepoWorkspace } from "../git/workspace.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "../../../../");
const GOLDEN_JSON_PATH = path.join(
  WORKSPACE_ROOT,
  "docs/bob-brief/examples/outline-13673.walkthrough.json"
);

const CACHE_DIR = process.env.GIT_CACHE_DIR ?? "/tmp/pr-walkthrough-repos";
const REPO_URL = "https://github.com/outline/outline";
const REPO_NAME = "outline__outline";
const REPO_PATH = path.join(CACHE_DIR, REPO_NAME);
const HEAD_SHA = "70ef12b";

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let goldenDraft: WalkthroughDraft;
let goldenHunks: Hunk[];
let input: AnalyzerInput;
let workspace: RepoWorkspace;

beforeAll(async () => {
  // Load golden JSON.
  const raw = JSON.parse(await readFile(GOLDEN_JSON_PATH, "utf-8"));

  // Strip the backend-populated fields to produce a WalkthroughDraft.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hunks, coverage, ...draft } = raw;
  goldenDraft = draft as WalkthroughDraft;
  goldenHunks = hunks as Hunk[];

  // Resolve the base SHA from HEAD_SHA^.
  const { stdout } = await execFileAsync(
    "git",
    ["-C", REPO_PATH, "rev-parse", `${HEAD_SHA}^`],
    { maxBuffer: 1024 * 1024 }
  );
  const baseSha = stdout.trim();

  // Prepare the real workspace (repo is already cloned).
  workspace = await prepareWorkspace(REPO_URL, HEAD_SHA, baseSha, 13673, CACHE_DIR);

  input = {
    repoPath: workspace.repoPath,
    baseSha,
    headSha: HEAD_SHA,
    pr: raw.pr,
    hunks: goldenHunks,
    diff: "",
  };
}, 5 * 60 * 1000); // allow time for checkout if needed

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe("validate — happy path", () => {
  it(
    "passes all checks and returns the assembled Walkthrough",
    async () => {
      const result = await validate(goldenDraft, input, workspace);

      expect(result.valid, result.errors.join("\n")).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.walkthrough).toBeDefined();
    },
    60_000
  );

  it("computes correct coverage from the golden draft", () => {
    const coverage = computeCoverage(goldenDraft, goldenHunks);

    // 13 total hunks; 9 explained (unique across all steps), 4 skipped, 0 uncovered.
    expect(coverage.totalHunks).toBe(13);
    expect(coverage.explained).toBe(9);
    expect(coverage.skipped).toBe(4);
    expect(coverage.uncoveredHunkIds).toHaveLength(0);
  });

  it("attaches hunks and coverage to the assembled Walkthrough", async () => {
    const result = await validate(goldenDraft, input, workspace);

    expect(result.walkthrough?.hunks).toHaveLength(goldenHunks.length);
    expect(result.walkthrough?.coverage?.totalHunks).toBe(13);
    expect(result.walkthrough?.coverage?.uncoveredHunkIds).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Schema failure
// ---------------------------------------------------------------------------

describe("validate — schema failure", () => {
  it("returns valid=false with an error naming the missing field", () => {
    // Remove a required top-level field.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { summary, ...withoutSummary } = goldenDraft as Record<string, unknown>;
    const result = validateSchema(withoutSummary);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // At least one error should mention "summary".
    expect(result.errors.some((e) => e.includes("summary"))).toBe(true);
  });

  it("returns valid=false when schemaVersion is wrong", () => {
    const bad = { ...goldenDraft, schemaVersion: 2 };
    const result = validateSchema(bad);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Verbatim failure
// ---------------------------------------------------------------------------

describe("validate — verbatim failure", () => {
  it(
    "returns valid=false with an error naming the mutated step and line",
    async () => {
      // Mutate a non-elided code line in step s1, beat 0, block 0, line 0.
      // That block is:
      //   file: app/scenes/Document/components/ChangesNavigation.tsx
      //   revision: base
      //   line 0: '  const showChanges = query.get("changes");'
      const mutated: WalkthroughDraft = {
        ...goldenDraft,
        steps: goldenDraft.steps.map((s) => {
          if (s.id !== "s1") return s;
          return {
            ...s,
            beats: s.beats.map((b, bi) => {
              if (bi !== 0 || !b.code) return b;
              return {
                ...b,
                code: b.code.map((block, ci) => {
                  if (ci !== 0) return block;
                  return {
                    ...block,
                    lines: block.lines.map((line, li) => {
                      if (li !== 0) return line;
                      return {
                        ...line,
                        text: "  THIS_LINE_DOES_NOT_EXIST_IN_ANY_FILE_XYZ;",
                      };
                    }),
                  };
                }),
              };
            }),
          };
        }),
      };

      const result = await validate(mutated, input, workspace, { mechanicalFix: false });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // Error should name the step.
      expect(result.errors.some((e) => e.includes("s1"))).toBe(true);
    },
    60_000
  );
});

// ---------------------------------------------------------------------------
// 4. Coverage failure (uncovered hunks)
// ---------------------------------------------------------------------------

describe("validate — coverage failure", () => {
  it(
    "returns valid=false when step hunkIds are removed and hunks become uncovered",
    async () => {
      // Remove all hunkIds from steps s2 AND s10 so ChangesNavigation.tsx#1
      // (referenced only by s2 and s10) becomes uncovered.
      const mutated: WalkthroughDraft = {
        ...goldenDraft,
        steps: goldenDraft.steps.map((s) => {
          if (s.id !== "s2" && s.id !== "s10") return s;
          return { ...s, hunkIds: [] };
        }),
      };

      const result = await validate(mutated, input, workspace, { mechanicalFix: false });

      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) =>
          e.includes("app/scenes/Document/components/ChangesNavigation.tsx#1")
        )
      ).toBe(true);
    },
    60_000
  );

  it("by default a left-out hunk is listed as not explained instead of failing the run", async () => {
    const mutated: WalkthroughDraft = {
      ...goldenDraft,
      steps: goldenDraft.steps.map((s) => (s.id === "s2" || s.id === "s10" ? { ...s, hunkIds: [] } : s)),
    };
    const result = await validate(mutated, input, workspace);
    expect(result.errors).toEqual([]);
    expect(result.walkthrough!.skippedHunks.find((h) => h.hunkId === "app/scenes/Document/components/ChangesNavigation.tsx#1")?.reason).toMatch(/left this change out/);
    expect(goldenDraft.skippedHunks.some((h) => h.hunkId === "app/scenes/Document/components/ChangesNavigation.tsx#1")).toBe(false);
  }, 60_000);

  it("computeCoverage reports uncoveredHunkIds correctly", () => {
    const mutated: WalkthroughDraft = {
      ...goldenDraft,
      steps: goldenDraft.steps.map((s) => {
        if (s.id !== "s2" && s.id !== "s10") return s;
        return { ...s, hunkIds: [] };
      }),
    };

    const coverage = computeCoverage(mutated, goldenHunks);
    expect(coverage.uncoveredHunkIds).toContain(
      "app/scenes/Document/components/ChangesNavigation.tsx#1"
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Plain-layer fields — schema accepts and preserves them
// ---------------------------------------------------------------------------

describe("WalkthroughSchema — plain-layer fields", () => {
  it("accepts a walkthrough with plain, headline, say, check, minor, visual, plainLabel, short", () => {
    // Build a minimal walkthrough-like object augmented with all plain-layer fields.
    // We test the schema directly (no verbatim/coverage check needed).
    const withPlain = {
      ...goldenDraft,
      plain: {
        title: "The history counter shows up at once",
        problem: "The counter was missing or stuck.",
        fix: "Count where the comparison is made.",
      },
      steps: goldenDraft.steps.map((s, i) => ({
        ...s,
        headline: i === 0 ? "The change counter is missing or stuck" : undefined,
        say: i === 0 ? "When you open an older version the header should show changes." : undefined,
        check: i === 0 ? "Both now use has(). Should a flag with no value turn changes on?" : undefined,
        minor: i === 8 ? true : undefined,
        visual:
          i === 0
            ? { type: "symptoms" as const, items: ["Counter doesn't appear", "Counter stays stuck"] }
            : undefined,
      })),
      graph: {
        ...goldenDraft.graph,
        edges: goldenDraft.graph.edges.map((e, i) =>
          i === 0 ? { ...e, plainLabel: "passes the editor down" } : e
        ),
      },
      openQuestions: goldenDraft.openQuestions.map((q, i) =>
        i === 0 ? { ...q, short: "Does the position reset after editor rebuild?" } : q
      ),
    };

    const result = validateSchema(withPlain);
    expect(result.valid, result.errors.join("\n")).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("preserves plain-layer fields after parsing (no silent stripping)", async () => {
    const { WalkthroughSchema } = await import("@pr-walkthrough/shared");
    const withPlain = {
      ...goldenDraft,
      hunks: [], // schema requires hunks
      plain: { title: "Short title", problem: "A problem.", fix: "A fix." },
      steps: goldenDraft.steps.map((s, i) =>
        i === 0 ? { ...s, headline: "Short headline", say: "One sentence.", check: "One check.", minor: false } : s
      ),
    };

    const parsed = WalkthroughSchema.safeParse(withPlain);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.plain?.title).toBe("Short title");
    expect(parsed.data.steps[0].headline).toBe("Short headline");
    expect(parsed.data.steps[0].say).toBe("One sentence.");
    expect(parsed.data.steps[0].check).toBe("One check.");
    expect(parsed.data.steps[0].minor).toBe(false);
  });
});
