/**
 * progress-normalizer.test.ts — unit tests for createProgressNormalizer:
 * raw `bob run --format stream-json` events → the small ProgressEvent stream.
 */

import { describe, it, expect } from "vitest";
import type { ProgressEvent } from "@pr-walkthrough/shared";
import { createProgressNormalizer } from "../analyzer/progress-normalizer.js";

function collect() {
  const emitted: ProgressEvent[] = [];
  const normalizer = createProgressNormalizer(0, (e) => emitted.push(e));
  return { emitted, normalizer };
}

describe("createProgressNormalizer", () => {
  it("never forwards the user-role prompt echo", () => {
    const { emitted, normalizer } = collect();
    normalizer.handle({ type: "message", role: "user", content: "the full prompt, including a golden example" }, 100);
    expect(emitted).toEqual([]);
  });

  it("ignores malformed / non-object input", () => {
    const { emitted, normalizer } = collect();
    normalizer.handle(undefined, 100);
    normalizer.handle("raw unparsed line", 100);
    normalizer.handle(null, 100);
    expect(emitted).toEqual([]);
  });

  it("collapses assistant text deltas into one throttled 'writing' event", () => {
    const { emitted, normalizer } = collect();
    // Three deltas within the same 1s throttle window: only the first fires.
    normalizer.handle({ type: "message", role: "assistant", content: "Now " }, 0);
    normalizer.handle({ type: "message", role: "assistant", content: "let " }, 200);
    normalizer.handle({ type: "message", role: "assistant", content: "me " }, 400);
    expect(emitted).toEqual([{ kind: "writing", t: 0, chars: 4 }]);

    // A delta after the throttle window fires again, with the cumulative char count.
    normalizer.handle({ type: "message", role: "assistant", content: "look." }, 1100);
    expect(emitted).toEqual([
      { kind: "writing", t: 0, chars: 4 },
      { kind: "writing", t: 1100, chars: 16 },
    ]);
  });

  it("emits a 'tool' event for read_file with a shortened, repo-relative path", () => {
    const { emitted, normalizer } = collect();
    normalizer.handle(
      {
        type: "tool_use",
        tool_name: "read_file",
        parameters: {
          path: "/tmp/pr-walkthrough-repos/excalidraw__excalidraw/wt/abc123/packages/excalidraw/components/Sidebar.tsx",
        },
      },
      500
    );
    expect(emitted).toEqual([
      { kind: "tool", t: 500, tool: "read_file", target: "Reading packages/excalidraw/components/Sidebar.tsx" },
    ]);
  });

  it("emits a 'tool' event for grep with the search pattern", () => {
    const { emitted, normalizer } = collect();
    normalizer.handle({ type: "tool_use", tool_name: "grep", parameters: { pattern: "useOutsideClick" } }, 10);
    expect(emitted).toEqual([{ kind: "tool", t: 10, tool: "grep", target: "Searching for `useOutsideClick`" }]);
  });

  it("detects a spawn_subagent tool call and truncates its description to ~80 chars", () => {
    const { emitted, normalizer } = collect();
    const longDesc = "a".repeat(120);
    normalizer.handle(
      { type: "tool_use", tool_name: "spawn_subagent", parameters: { name: "explore", description: longDesc } },
      10
    );
    expect(emitted).toHaveLength(1);
    const e = emitted[0] as Extract<ProgressEvent, { kind: "tool" }>;
    expect(e.kind).toBe("tool");
    expect(e.tool).toBe("spawn_subagent");
    expect(e.target.startsWith("Sub-agent: ")).toBe(true);
    expect(e.target.length).toBeLessThanOrEqual("Sub-agent: ".length + 81);
  });

  it("ignores tool_result events (no UI signal today)", () => {
    const { emitted, normalizer } = collect();
    normalizer.handle({ type: "tool_result", tool_id: "x", status: "success", output: "..." }, 10);
    expect(emitted).toEqual([]);
  });

  it("does not forward a Bob error event (it is not the run failing — the pipeline reports its own)", () => {
    const { emitted, normalizer } = collect();
    normalizer.handle({ type: "error", message: "The task reached the cost limit" }, 10);
    expect(emitted).toEqual([]);
  });

  it("with a run tracker, cost events carry the whole run's total across Bob tasks", () => {
    const emitted: unknown[] = [];
    const tracker = { tasks: new Map<string, number>(), maxUsd: 9.5 };
    const analysis = createProgressNormalizer(0, (e) => emitted.push(e), { tracker, task: "analysis" });
    const verifier = createProgressNormalizer(0, (e) => emitted.push(e), { tracker, task: "verifier" });
    analysis.handle({ type: "result", stats: { session_costs: 0.6, max_cost: 4.9 } }, 1);
    verifier.handle({ type: "result", stats: { session_costs: 0.4, max_cost: 2 } }, 2);
    analysis.handle({ type: "result", stats: { session_costs: 0.75, max_cost: 1.6 } }, 3); // resume: cumulative
    expect(emitted.map((e) => (e as { costUsd: number }).costUsd)).toEqual([0.6, 1.0, 1.15]);
    expect(emitted.every((e) => (e as { maxCostUsd: number }).maxCostUsd === 9.5)).toBe(true);
  });

  it("turns a final 'result' event's stats into a 'cost' event", () => {
    const { emitted, normalizer } = collect();
    normalizer.handle(
      {
        type: "result",
        status: "success",
        stats: { task_id: "abc", duration_ms: 282095, session_costs: 2.529143, max_cost: 3, tool_calls: 36 },
      },
      282100
    );
    expect(emitted).toEqual([{ kind: "cost", t: 282100, costUsd: 2.529143, maxCostUsd: 3 }]);
  });

  it("computes t relative to the normalizer's startMs", () => {
    const emitted: ProgressEvent[] = [];
    const normalizer = createProgressNormalizer(1_000_000, (e) => emitted.push(e));
    normalizer.handle({ type: "tool_use", tool_name: "read_file", parameters: { path: "/a/b.ts" } }, 1_000_500);
    expect((emitted[0] as { t: number }).t).toBe(500);
  });
});
