/**
 * ndjson-buffer.test.ts — unit tests for NdjsonBuffer's partial-line handling.
 */

import { describe, it, expect } from "vitest";
import { NdjsonBuffer } from "../analyzer/ndjson-buffer.js";

describe("NdjsonBuffer", () => {
  it("returns nothing for a chunk with no newline yet", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push('{"a":1}')).toEqual([]);
  });

  it("parses a single complete line", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push('{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it("splits a line across two chunks", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push('{"a":1')).toEqual([]);
    expect(buf.push('}\n')).toEqual([{ a: 1 }]);
  });

  it("splits a line across three chunks", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push('{"a":')).toEqual([]);
    expect(buf.push("1,")).toEqual([]);
    expect(buf.push('"b":2}\n')).toEqual([{ a: 1, b: 2 }]);
  });

  it("handles multiple complete lines in one chunk", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push('{"a":1}\n{"b":2}\n{"c":3}\n')).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("keeps a trailing partial line buffered when the chunk ends mid-line", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push('{"a":1}\n{"b":2')).toEqual([{ a: 1 }]);
    expect(buf.push("}\n")).toEqual([{ b: 2 }]);
  });

  it("skips blank lines", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push('{"a":1}\n\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("passes through a line that isn't valid JSON as a raw string", () => {
    const buf = new NdjsonBuffer();
    expect(buf.push("not json\n")).toEqual(["not json"]);
  });

  it("flush() parses a trailing line with no final newline", () => {
    const buf = new NdjsonBuffer();
    buf.push('{"a":1}\n{"b":2}');
    expect(buf.flush()).toEqual([{ b: 2 }]);
  });

  it("flush() returns nothing when the buffer is empty or blank", () => {
    const buf = new NdjsonBuffer();
    buf.push('{"a":1}\n');
    expect(buf.flush()).toEqual([]);

    const buf2 = new NdjsonBuffer();
    buf2.push("   ");
    expect(buf2.flush()).toEqual([]);
  });
});
