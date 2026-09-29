import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";

import { changedRegion, comparePngs, decodePng } from "./png-diff.js";

/** Minimal PNG encoder for tests: RGBA, 8-bit, filter type per row (CRCs left zero — the decoder ignores them). */
function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
  filterFor: (y: number) => number = () => 0
): Buffer {
  const stride = width * 4;
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(...pixel(x, y));
    rows.push(row);
  }
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filterFor(y);
    filtered[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rows[y][x - 4] : 0;
      const up = y > 0 ? rows[y - 1][x] : 0;
      const upLeft = y > 0 && x >= 4 ? rows[y - 1][x - 4] : 0;
      let pred = 0;
      if (f === 1) pred = left;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (left + up) >> 1;
      else if (f === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      filtered[y * (stride + 1) + 1 + x] = (rows[y][x] - pred) & 0xff;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(filtered)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const white = (): [number, number, number, number] => [255, 255, 255, 255];
const gradient = (x: number, y: number): [number, number, number, number] => [x * 7 % 256, y * 5 % 256, (x + y) * 3 % 256, 255];

describe("decodePng", () => {
  it("round-trips every scanline filter type", () => {
    const png = makePng(16, 10, gradient, (y) => y % 5);
    const d = decodePng(png)!;
    expect(d.width).toBe(16);
    expect(d.height).toBe(10);
    for (const [x, y] of [[0, 0], [5, 3], [15, 9], [8, 4]]) {
      const o = (y * 16 + x) * 4;
      expect([...d.data.subarray(o, o + 4)]).toEqual(gradient(x, y));
    }
  });

  it("returns null for non-PNG or unsupported input instead of guessing", () => {
    expect(decodePng(Buffer.from("not a png at all, just some text bytes here"))).toBeNull();
    const png = makePng(4, 4, white);
    png[24] = 16; // bit depth 16 — unsupported
    expect(decodePng(png)).toBeNull();
  });
});

describe("comparePngs", () => {
  it("calls the same frame identical", () => {
    const a = makePng(64, 40, gradient);
    const r = comparePngs(a, makePng(64, 40, gradient))!;
    expect(r.identical).toBe(true);
    expect(r.changedRatio).toBe(0);
  });

  it("ignores tiny per-channel noise", () => {
    const noisy = makePng(64, 40, (x, y) => {
      const [r, g, b, a] = gradient(x, y);
      return [Math.min(255, r + 3), g, b, a];
    });
    expect(comparePngs(makePng(64, 40, gradient), noisy)!.identical).toBe(true);
  });

  it("ignores a couple of stray pixels (blinking caret) but not a real region", () => {
    const base = makePng(100, 100, white);
    const caret = makePng(100, 100, (x, y) => (x === 3 && y < 3 ? [0, 0, 0, 255] : white()));
    expect(comparePngs(base, caret)!.identical).toBe(true);

    const panel = makePng(100, 100, (x) => (x >= 70 ? [40, 40, 40, 255] : white()));
    const r = comparePngs(base, panel)!;
    expect(r.identical).toBe(false);
    expect(r.changedRatio).toBeCloseTo(0.3, 2);
  });

  it("treats different sizes as different", () => {
    const r = comparePngs(makePng(10, 10, white), makePng(10, 12, white))!;
    expect(r).toEqual({ changedRatio: 1, identical: false });
  });

  it("returns null (unknown) when a frame can't be decoded", () => {
    expect(comparePngs(makePng(4, 4, white), Buffer.from("garbage"))).toBeNull();
  });
});

describe("changedRegion", () => {
  it("returns the bounding box of what differs, as fractions", () => {
    const base = makePng(100, 100, white);
    const changed = makePng(100, 100, (x, y) => (x >= 60 && x < 90 && y >= 10 && y < 30 ? [20, 20, 20, 255] : white()));
    const r = changedRegion(base, changed)!;
    expect(r.x).toBeCloseTo(0.6, 2);
    expect(r.y).toBeCloseTo(0.1, 2);
    expect(r.w).toBeCloseTo(0.3, 2);
    expect(r.h).toBeCloseTo(0.2, 2);
    expect(r.ratio).toBeCloseTo(0.06, 2);
  });

  it("is null for identical frames, different sizes and undecodable input", () => {
    const a = makePng(20, 20, white);
    expect(changedRegion(a, makePng(20, 20, white))).toBeNull();
    expect(changedRegion(a, makePng(20, 30, white))).toBeNull();
    expect(changedRegion(a, Buffer.from("nope"))).toBeNull();
  });

  it("ignores a couple of stray pixels", () => {
    expect(changedRegion(makePng(100, 100, white), makePng(100, 100, (x, y) => (x === 3 && y < 3 ? [0, 0, 0, 255] : white())))).toBeNull();
  });
});
