import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { Walkthrough } from "@pr-walkthrough/shared";
import {
  captureSymptomShots,
  attachSymptomShots,
  findSymptomsStep,
  listSymptomTexts,
  parseSymptomsManifest,
  symptomItemText,
} from "./symptom-shots.js";

function minimalWt(items: Walkthrough["steps"][number]["visual"]): Walkthrough {
  const baseStep = {
    tag: "fact" as const,
    narration: "n",
    focusNode: "n1",
    beats: [] as [],
    hunkIds: [] as string[],
    sources: [] as [],
  };
  return {
    schemaVersion: 1,
    pr: {
      repo: "excalidraw/excalidraw",
      number: 10295,
      title: "t",
      url: "https://github.com/excalidraw/excalidraw/pull/10295",
      author: "a",
      filesChanged: 1,
      additions: 1,
      deletions: 1,
      commitTitles: [],
    },
    summary: { problem: "p", solution: "s" },
    hunks: [],
    graph: { nodes: [], edges: [] },
    steps: [
      {
        id: "s1",
        kind: "symptom",
        routeLabel: "Symptoms",
        title: "Symptoms",
        ...baseStep,
        visual: items,
      },
      {
        id: "s2",
        kind: "change",
        routeLabel: "Change",
        title: "Change",
        ...baseStep,
        minor: true,
        visual: { type: "symptoms", items: ["ignored minor"] },
      },
    ],
    skippedHunks: [],
    openQuestions: [],
    coverage: { totalHunks: 0, explained: 0, skipped: 0, uncoveredHunkIds: [] },
    meta: { analyzer: "manual", generatedAt: "2026-01-01T00:00:00Z", language: "en" },
  };
}

describe("parseSymptomsManifest", () => {
  it("parses skip and file entries", () => {
    const m = parseSymptomsManifest({
      items: [
        { index: 0, skip: "not visible in a still" },
        { index: 1, file: "symptom-1.cjs", src: "symptom-1.png" },
        { index: "x", file: "bad.cjs" },
        { index: 2, file: "../evil.cjs" },
      ],
    });
    expect(m).toEqual({
      items: [
        { index: 0, skip: "not visible in a still" },
        { index: 1, file: "symptom-1.cjs", src: "symptom-1.png" },
        { index: 2, file: "evil.cjs" },
      ],
    });
  });

  it("accepts a bare array (Bob's common shape)", () => {
    expect(
      parseSymptomsManifest([
        { index: 0, skip: "not visible" },
        { index: 1, file: "symptom-1.cjs" },
      ])
    ).toEqual({
      items: [
        { index: 0, skip: "not visible" },
        { index: 1, file: "symptom-1.cjs" },
      ],
    });
  });

  it("returns null for empty or malformed input", () => {
    expect(parseSymptomsManifest(null)).toBeNull();
    expect(parseSymptomsManifest({})).toBeNull();
    expect(parseSymptomsManifest({ items: [{ index: 0 }] })).toBeNull();
  });

  it("rejects non-.cjs files", () => {
    expect(parseSymptomsManifest({ items: [{ index: 0, file: "symptom-0.js" }] })).toBeNull();
  });
});

describe("listSymptomTexts / findSymptomsStep", () => {
  it("reads texts from the first non-minor symptoms step", () => {
    const wt = minimalWt({
      type: "symptoms",
      items: ["Toolbar over sidebar", { text: "Menu under sidebar", src: "old.png" }],
    });
    expect(findSymptomsStep(wt)?.id).toBe("s1");
    expect(listSymptomTexts(wt)).toEqual(["Toolbar over sidebar", "Menu under sidebar"]);
    expect(symptomItemText("plain")).toBe("plain");
  });

  it("returns empty when there is no symptoms visual", () => {
    const wt = minimalWt({ type: "flow", rows: [[["a", ""]]] });
    expect(listSymptomTexts(wt)).toEqual([]);
  });
});

describe("attachSymptomShots", () => {
  it("attaches src by index and normalizes string items", () => {
    const wt = minimalWt({
      type: "symptoms",
      items: ["Toolbar over sidebar", { text: "Menu under sidebar" }],
    });
    attachSymptomShots(wt, new Map([[1, "symptom-1-annotated.png"]]));
    const items = findSymptomsStep(wt)!.visual!;
    expect(items).toEqual({
      type: "symptoms",
      items: [
        "Toolbar over sidebar",
        { text: "Menu under sidebar", src: "symptom-1-annotated.png" },
      ],
    });
  });

  it("accepts a plain record and overwrites an existing src", () => {
    const wt = minimalWt({
      type: "symptoms",
      items: [{ text: "A", src: "old.png" }, { text: "B" }],
    });
    attachSymptomShots(wt, { 0: "symptom-0.png" });
    expect(findSymptomsStep(wt)!.visual).toEqual({
      type: "symptoms",
      items: [{ text: "A", src: "symptom-0.png" }, { text: "B" }],
    });
  });

  it("is a no-op when there is no symptoms step", () => {
    const wt = minimalWt({ type: "layers", before: [["x", 1]], after: [["x", 2]] });
    const before = JSON.stringify(wt.steps);
    attachSymptomShots(wt, { 0: "x.png" });
    expect(JSON.stringify(wt.steps)).toBe(before);
  });
});

/** Solid-colour RGBA PNG (filter 0, CRCs zero — the decoder ignores them). */
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(rgba, y * (stride + 1) + 1 + x * 4);
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("captureSymptomShots — frames that add nothing are dropped", () => {
  it("keeps a frame that differs from the main before shot, drops one that looks the same", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "symptoms-"));
    try {
      const verifyDir = path.join(dir, "verify");
      const outDir = path.join(dir, "out");
      await mkdir(verifyDir, { recursive: true });
      await mkdir(outDir, { recursive: true });

      const beforePath = path.join(outDir, "before.png");
      await writeFile(beforePath, solidPng(40, 30, [255, 255, 255, 255]));
      await writeFile(path.join(dir, "same.png"), solidPng(40, 30, [255, 255, 255, 255]));
      await writeFile(path.join(dir, "other.png"), solidPng(40, 30, [20, 20, 20, 255]));

      const script = (fixture: string) =>
        `require("fs").copyFileSync(${JSON.stringify(path.join(dir, fixture))}, process.argv[3]);` +
        `console.log(JSON.stringify({ ok: true, highlights: [] }));`;
      await writeFile(path.join(verifyDir, "symptom-0.cjs"), script("same.png"));
      await writeFile(path.join(verifyDir, "symptom-1.cjs"), script("other.png"));
      await writeFile(
        path.join(verifyDir, "symptoms.json"),
        JSON.stringify({
          items: [
            { index: 0, file: "symptom-0.cjs" },
            { index: 1, file: "symptom-1.cjs" },
          ],
        })
      );

      const { srcByIndex, notes } = await captureSymptomShots({
        verifyDir,
        baseUrl: "http://127.0.0.1:0",
        outDir,
        symptomCount: 2,
        beforePath,
      });

      expect([...srcByIndex.entries()]).toEqual([[1, "symptom-1.png"]]);
      expect(notes.join("\n")).toMatch(/symptom 0: looks the same as the main before screenshot — dropped/);
      expect(existsSync(path.join(outDir, "symptom-1.png"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps every frame when there is no main before shot to compare against", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "symptoms-"));
    try {
      const verifyDir = path.join(dir, "verify");
      const outDir = path.join(dir, "out");
      await mkdir(verifyDir, { recursive: true });
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(dir, "a.png"), solidPng(10, 10, [1, 2, 3, 255]));
      await writeFile(
        path.join(verifyDir, "symptom-0.cjs"),
        `require("fs").copyFileSync(${JSON.stringify(path.join(dir, "a.png"))}, process.argv[3]);console.log(JSON.stringify({ok:true,highlights:[]}));`
      );
      await writeFile(path.join(verifyDir, "symptoms.json"), JSON.stringify([{ index: 0, file: "symptom-0.cjs" }]));

      const { srcByIndex } = await captureSymptomShots({
        verifyDir,
        baseUrl: "http://127.0.0.1:0",
        outDir,
        symptomCount: 1,
      });
      expect([...srcByIndex.keys()]).toEqual([0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
