import { describe, it, expect } from "vitest";

import { extractJsonObject, findWalkthroughInEvents } from "./bob-shell.js";
import { parseRepairedJsonObject, repairJsonObject } from "./json-repair.js";

const repair = (s: string) => parseRepairedJsonObject(s, s.indexOf("{"));

describe("repairJsonObject", () => {
  it("escapes a quoted phrase inside a string (the real failure: prose in a value)", () => {
    const text = '{"a":"The handler checks "did the click land inside?" and skips closing.","b":2}';
    expect(() => JSON.parse(text)).toThrow();
    expect(repair(text)).toEqual({ a: 'The handler checks "did the click land inside?" and skips closing.', b: 2 });
  });

  it("handles several inner quotes and a quote right before punctuation in prose", () => {
    const text = '{"say":"Called "fast path", not "slow path". Done.","n":[1,2]}';
    expect(repair(text)).toEqual({ say: 'Called "fast path", not "slow path". Done.', n: [1, 2] });
  });

  it("keeps real structure: keys, arrays of strings, nested objects", () => {
    const text = '{"steps":[{"id":"s1","say":"one"},{"id":"s2","say":"two"}],"meta":{"k":"v"}}';
    expect(repair(text)).toEqual(JSON.parse(text));
  });

  it("escapes raw newlines and tabs inside strings", () => {
    const text = '{"a":"line one\nline two\tend"}';
    expect(repair(text)).toEqual({ a: "line one\nline two\tend" });
  });

  it("drops trailing commas", () => {
    expect(repair('{"a":[1,2,],"b":{"c":1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });

  it("leaves braces, colons and escaped quotes inside strings alone", () => {
    const text = '{"code":"if (x) { return a ? b : c; }","q":"say \\"hi\\" now"}';
    expect(repair(text)).toEqual({ code: "if (x) { return a ? b : c; }", q: 'say "hi" now' });
  });

  it("returns undefined when the object never closes (truncated answer)", () => {
    expect(repairJsonObject('{"a":"abc","b":[1,2', 0)).toBeUndefined();
    expect(repair('{"a":"unterminated')).toBeUndefined();
  });

  it("starts only at an object", () => {
    expect(repairJsonObject("[1,2]", 0)).toBeUndefined();
  });
});

describe("extractJsonObject falls back to repair only when strict parsing finds nothing", () => {
  const isWt = (v: unknown) => !!v && typeof v === "object" && "steps" in (v as object) && "graph" in (v as object);

  it("recovers a walkthrough-shaped answer with prose before it and a bad quote inside", () => {
    const answer =
      'Now I have everything. Let me produce the final JSON:\n\n' +
      '{"schemaVersion":1,"graph":{"nodes":[],"edges":[]},"steps":[{"id":"s1","say":"It asks "is this inside?" first."}]}';
    const wt = extractJsonObject(answer, isWt) as { steps: { say: string }[] };
    expect(wt.steps[0].say).toBe('It asks "is this inside?" first.');
  });

  it("prefers a strictly valid object over repairing a broken one", () => {
    const good = '{"steps":[],"graph":{},"marker":"strict"}';
    const bad = '{"steps":[],"graph":{},"marker":"has "inner" quotes"}';
    const found = extractJsonObject(`${bad}\n${good}`, isWt) as { marker: string };
    expect(found.marker).toBe("strict");
  });

  it("does not invent a walkthrough from text that has none", () => {
    expect(extractJsonObject("no json here, just a sentence with a { brace", isWt)).toBeUndefined();
  });

  it("works through findWalkthroughInEvents (assistant text only, not the echoed prompt)", () => {
    const events = [
      { role: "user", content: '{"steps":[],"graph":{},"from":"prompt example"}' },
      { role: "assistant", content: 'Final:\n{"steps":[{"id":"s1","say":"a "b" c"}],"graph":{"nodes":[],"edges":[]}}' },
    ];
    const wt = findWalkthroughInEvents(events) as { steps: { say: string }[] };
    expect(wt.steps[0].say).toBe('a "b" c');
  });
});
