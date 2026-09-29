/**
 * png-diff.ts — do two screenshots actually look different?
 *
 * The verifier can measure a bug that leaves no visible trace in a still (pure
 * stacking order, a handler that no longer fires). Showing "before" and "after"
 * frames that are pixel-identical then reads as broken evidence, so the backend
 * checks it itself instead of trusting the model's "looks different" claim.
 *
 * Dependency-free on purpose (no image library in the server): a small decoder
 * for the PNGs Playwright writes — 8-bit, non-interlaced, grey/RGB/RGBA. Anything
 * else returns null, and callers must treat null as "unknown", never "identical".
 */

import { inflateSync } from "node:zlib";

interface Decoded {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Decoded | null {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  for (let pos = 8; pos + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (body.length < length) return null;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colorType = body[9];
      const interlace = body[12];
      channels = CHANNELS[colorType] ?? 0;
      if (bitDepth !== 8 || interlace !== 0 || channels === 0) return null;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (!width || !height || idat.length === 0) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const data = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[dst + x - channels] : 0;
      const up = y > 0 ? data[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      let out: number;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + left; break;
        case 2: out = v + up; break;
        case 3: out = v + ((left + up) >> 1); break;
        case 4: out = v + paeth(left, up, upLeft); break;
        default: return null;
      }
      data[dst + x] = out & 0xff;
    }
  }
  return { width, height, channels, data };
}

export interface PngComparison {
  /** Share of pixels (0–1) that differ by more than the per-channel tolerance. */
  changedRatio: number;
  /** True when the frames are visually the same (see IDENTICAL_RATIO). */
  identical: boolean;
}

/** Per-channel difference that still counts as "the same pixel" (anti-aliasing, blinking caret). */
const CHANNEL_TOLERANCE = 8;
/** Below this share of changed pixels two frames read as the same picture to a person. */
export const IDENTICAL_RATIO = 0.0005;

/** Returns null when either image can't be decoded — callers must not assume "identical". */
export function comparePngs(a: Buffer, b: Buffer): PngComparison | null {
  const da = decodePng(a);
  const db = decodePng(b);
  if (!da || !db) return null;
  if (da.width !== db.width || da.height !== db.height || da.channels !== db.channels) {
    return { changedRatio: 1, identical: false };
  }
  const pixels = da.width * da.height;
  let changed = 0;
  for (let p = 0; p < pixels; p++) {
    const o = p * da.channels;
    for (let c = 0; c < da.channels; c++) {
      if (Math.abs(da.data[o + c] - db.data[o + c]) > CHANNEL_TOLERANCE) {
        changed++;
        break;
      }
    }
  }
  const changedRatio = changed / pixels;
  return { changedRatio, identical: changedRatio < IDENTICAL_RATIO };
}

export interface ChangedRegion {
  /** Bounding box of the pixels that differ, as fractions of the image (0–1). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Share of pixels that differ (0–1). */
  ratio: number;
}

/**
 * Where two frames of the same page differ: the bounding box of the changed pixels. The verifier's
 * model marks what it thinks matters ("the whole sidebar"); this is what actually changed between
 * BASE and HEAD, which is what a reader should be looking at. null when the frames are
 * identical, differently sized, or can't be decoded.
 */
export function changedRegion(a: Buffer, b: Buffer): ChangedRegion | null {
  const da = decodePng(a);
  const db = decodePng(b);
  if (!da || !db || da.width !== db.width || da.height !== db.height || da.channels !== db.channels) return null;
  let minX = da.width, minY = da.height, maxX = -1, maxY = -1, changed = 0;
  for (let y = 0; y < da.height; y++) {
    for (let x = 0; x < da.width; x++) {
      const o = (y * da.width + x) * da.channels;
      for (let c = 0; c < da.channels; c++) {
        if (Math.abs(da.data[o + c] - db.data[o + c]) > CHANNEL_TOLERANCE) {
          changed++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          break;
        }
      }
    }
  }
  const ratio = changed / (da.width * da.height);
  if (maxX < 0 || ratio < IDENTICAL_RATIO) return null;
  return { x: minX / da.width, y: minY / da.height, w: (maxX - minX + 1) / da.width, h: (maxY - minY + 1) / da.height, ratio };
}
