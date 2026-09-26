/**
 * classify-hunks.test.ts — unit tests for classifyHunks and groupSkippedSummary.
 */

import { describe, it, expect } from "vitest";
import type { Hunk } from "@pr-walkthrough/shared";
import { classifyHunks, groupSkippedSummary } from "../analyzer/classify-hunks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hunk(file: string, n = 1): Hunk {
  return { id: `${file}#${n}`, file, header: `@@ -1,5 +1,6 @@`, added: 1, removed: 0 };
}

// ---------------------------------------------------------------------------
// 1. Individual rule coverage
// ---------------------------------------------------------------------------

describe("classifyHunks — rule coverage", () => {
  it("keeps source files in prompt", () => {
    const { prompt, skipped } = classifyHunks([hunk("src/components/Button.tsx")]);
    expect(prompt).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it("skips .test.ts files (tests)", () => {
    const { prompt, skipped } = classifyHunks([hunk("src/components/Button.test.ts")]);
    expect(prompt).toHaveLength(0);
    expect(skipped[0].reason).toBe("tests");
  });

  it("skips .spec.tsx files (tests)", () => {
    const { skipped } = classifyHunks([hunk("src/Button.spec.tsx")]);
    expect(skipped[0].reason).toBe("tests");
  });

  it("skips __tests__/ directory (tests)", () => {
    const { skipped } = classifyHunks([hunk("src/__tests__/utils.ts")]);
    expect(skipped[0].reason).toBe("tests");
  });

  it("skips .stories.tsx files (tests)", () => {
    const { skipped } = classifyHunks([hunk("src/Button.stories.tsx")]);
    expect(skipped[0].reason).toBe("tests");
  });

  it("skips __snapshots__/*.snap files (snapshots, not tests)", () => {
    const { skipped } = classifyHunks([hunk("src/__snapshots__/Button.test.tsx.snap")]);
    expect(skipped[0].reason).toBe("snapshots");
  });

  it("skips bare .snap files (snapshots)", () => {
    const { skipped } = classifyHunks([hunk("src/components/Button.snap")]);
    expect(skipped[0].reason).toBe("snapshots");
  });

  it("skips pnpm-lock.yaml (lockfile)", () => {
    const { skipped } = classifyHunks([hunk("pnpm-lock.yaml")]);
    expect(skipped[0].reason).toBe("lockfile");
  });

  it("skips yarn.lock (lockfile)", () => {
    const { skipped } = classifyHunks([hunk("yarn.lock")]);
    expect(skipped[0].reason).toBe("lockfile");
  });

  it("skips package-lock.json (lockfile)", () => {
    const { skipped } = classifyHunks([hunk("package-lock.json")]);
    expect(skipped[0].reason).toBe("lockfile");
  });

  it("skips /locales/ files (translations)", () => {
    const { skipped } = classifyHunks([hunk("app/locales/en.json")]);
    expect(skipped[0].reason).toBe("translations");
  });

  it("skips .po files (translations)", () => {
    const { skipped } = classifyHunks([hunk("i18n/messages.po")]);
    expect(skipped[0].reason).toBe("translations");
  });

  it("skips __generated__/ files (generated)", () => {
    const { skipped } = classifyHunks([hunk("src/__generated__/graphql.ts")]);
    expect(skipped[0].reason).toBe("generated");
  });

  it("skips *.generated.ts files (generated)", () => {
    const { skipped } = classifyHunks([hunk("src/api/client.generated.ts")]);
    expect(skipped[0].reason).toBe("generated");
  });

  it("skips *.pb.go files (generated)", () => {
    const { skipped } = classifyHunks([hunk("proto/service.pb.go")]);
    expect(skipped[0].reason).toBe("generated");
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple-hunk batch (simulate excalidraw#8340 scenario)
// ---------------------------------------------------------------------------

describe("classifyHunks — mixed batch", () => {
  it("correctly splits 5-hunk batch into prompt and skipped", () => {
    const hunks: Hunk[] = [
      hunk("src/renderer/renderElement.ts"),    // keep
      hunk("src/renderer/renderElement.test.ts"), // tests
      hunk("src/__snapshots__/App.test.tsx.snap"), // snapshots
      hunk("pnpm-lock.yaml"),                   // lockfile
      hunk("src/locales/en.json"),              // translations
    ];
    const { prompt, skipped } = classifyHunks(hunks);
    expect(prompt).toHaveLength(1);
    expect(prompt[0].file).toBe("src/renderer/renderElement.ts");
    expect(skipped).toHaveLength(4);
  });

  it("preserves hunk ids in skipped output", () => {
    const h = hunk("src/App.test.ts", 3);
    const { skipped } = classifyHunks([h]);
    expect(skipped[0].hunkId).toBe("src/App.test.ts#3");
  });

  it("applies first-match-wins (snapshots rule beats tests rule)", () => {
    // __snapshots__/*.snap could match BOTH tests (via __snapshots__? no — but
    // the file is *.snap) and snapshots. Snapshots rule is listed first.
    const { skipped } = classifyHunks([hunk("src/__snapshots__/Foo.snap")]);
    expect(skipped[0].reason).toBe("snapshots");
  });
});

// ---------------------------------------------------------------------------
// 3. groupSkippedSummary
// ---------------------------------------------------------------------------

describe("groupSkippedSummary", () => {
  it("collapses tests + snapshots into one line", () => {
    const skipped = [
      { hunkId: "a#1", reason: "tests" },
      { hunkId: "b#1", reason: "tests" },
      { hunkId: "c#1", reason: "snapshots" },
    ];
    const summary = groupSkippedSummary(skipped);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toBe("3 test and snapshot hunks");
  });

  it("produces separate lines for different reasons", () => {
    const skipped = [
      { hunkId: "a#1", reason: "tests" },
      { hunkId: "b#1", reason: "lockfile" },
      { hunkId: "c#1", reason: "translations" },
    ];
    const summary = groupSkippedSummary(skipped);
    expect(summary).toHaveLength(3);
    expect(summary[0]).toBe("1 test and snapshot hunk");
    expect(summary[1]).toBe("1 lockfile hunk");
    expect(summary[2]).toBe("1 translation hunk");
  });

  it("ignores non-mechanical reasons (authored by analyzer)", () => {
    const skipped = [
      { hunkId: "a#1", reason: "removed unused import" },
      { hunkId: "b#1", reason: "tests" },
    ];
    const summary = groupSkippedSummary(skipped);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toBe("1 test and snapshot hunk");
  });

  it("returns empty array when no mechanical hunks", () => {
    const summary = groupSkippedSummary([
      { hunkId: "a#1", reason: "removed unused import" },
    ]);
    expect(summary).toHaveLength(0);
  });

  it("uses singular for count=1", () => {
    const summary = groupSkippedSummary([{ hunkId: "a#1", reason: "lockfile" }]);
    expect(summary[0]).toBe("1 lockfile hunk");
  });

  it("uses plural for count>1", () => {
    const summary = groupSkippedSummary([
      { hunkId: "a#1", reason: "lockfile" },
      { hunkId: "b#1", reason: "lockfile" },
    ]);
    expect(summary[0]).toBe("2 lockfile hunks");
  });
});
