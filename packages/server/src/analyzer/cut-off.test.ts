import { describe, expect, it } from "vitest";

import { answerOf, findWalkthroughInEvents } from "./bob-shell.js";

// The live #12053 answer ended mid-string when the connection to Bob's service dropped.
const cut = '{"steps":[{"id":"s1","hunkIds":["a#1"]}],"graph":{"nodes":[],"edges":[]},"skippedHunks":[{"hunkId":"packages/excalidraw/components/dropdownMenu/Dropdown';
const events = [{ type: "message", role: "assistant", content: cut }];

describe("answerOf — a cut-off answer is never used", () => {
  it("without the final result event a truncated object is rejected", () => {
    expect(answerOf({ events, completed: false })).toBeUndefined();
  });

  it("a cut-off stream that already holds one whole answer (then a second, cut copy) uses the whole one", () => {
    const whole = '{"steps":[{"id":"s1","hunkIds":[]}],"graph":{"nodes":[],"edges":[]}}';
    const ev = [{ type: "message", role: "assistant", content: whole + "\n\nLet me refine it:\n" + cut }];
    expect((answerOf({ events: ev, completed: false }) as { steps: unknown[] }).steps).toHaveLength(1);
  });

  it("a stray quote is still repaired in a complete answer, but not in a cut-off one", () => {
    const bad = '{"steps":[{"id":"s1","hunkIds":[],"narration":"the "quoted" word"}],"graph":{"nodes":[],"edges":[]}}';
    const ev = [{ type: "message", role: "assistant", content: bad }];
    expect(answerOf({ events: ev, completed: true })).toBeDefined();
    expect(answerOf({ events: ev, completed: false })).toBeUndefined();
    expect(findWalkthroughInEvents(ev)).toBeDefined();
  });

  it("a complete answer is used", () => {
    const whole = [{ type: "message", role: "assistant", content: '{"steps":[],"graph":{"nodes":[],"edges":[]}}' }, { type: "result", stats: {} }];
    expect(answerOf({ events: whole, completed: true })).toBeDefined();
  });
});
