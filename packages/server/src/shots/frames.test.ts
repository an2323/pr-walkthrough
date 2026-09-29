import { describe, expect, it } from "vitest";

import { isPhoneFrame, pickMainIndex, pngDimensions } from "./frames.js";

function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe("frames", () => {
  it("reads PNG dimensions", () => expect(pngDimensions(pngHeader(390, 844))).toEqual({ width: 390, height: 844 }));
  it("phone frames: 1x, 2x and 3x captures of a 390 viewport; desktop is not", () => {
    expect(isPhoneFrame(pngHeader(390, 844))).toBe(true);
    expect(isPhoneFrame(pngHeader(780, 1688))).toBe(true);
    expect(isPhoneFrame(pngHeader(1280, 800))).toBe(false);
    expect(isPhoneFrame(pngHeader(2560, 1600))).toBe(false);
  });
  it("main pair: the widest visible one, not the first", () => {
    expect(pickMainIndex([{ visible: true, width: 390 }, { visible: true, width: 1280 }])).toBe(1);
    expect(pickMainIndex([{ visible: false, width: 1280 }, { visible: true, width: 390 }])).toBe(1);
    expect(pickMainIndex([{ visible: true, width: 1280 }, { visible: true, width: 1280 }])).toBe(0);
    expect(pickMainIndex([{ visible: false, width: 1280 }])).toBe(-1);
  });
});
