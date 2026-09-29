import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { loadScenarios, parseScenarios } from "./scenarios.js";
import { buildScenarioRepairPrompt, confirmScenarios, confirmScenariosWithRepair, scenarioProblems } from "./repro-confirm.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), "scenarios-"));
  dirs.push(d);
  return d;
};

function solidPng(rgba: [number, number, number, number]): Buffer {
  const w = 20, h = 20, stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgba, y * (stride + 1) + 1 + x * 4);
  const chunk = (t: string, b: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(b.length, 0);
    head.write(t, 4, "ascii");
    return Buffer.concat([head, b, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const WHITE = solidPng([255, 255, 255, 255]).toString("base64");
const DARK = solidPng([30, 30, 30, 255]).toString("base64");

/** A script whose BASE screenshot is white and HEAD screenshot is `headPng` (base64). */
const script = (headPng: string) => `
const fs = require("fs"); const u = process.argv[2]; const png = process.argv[3];
const base = u.includes("base");
if (png) fs.writeFileSync(png, Buffer.from(base ? "${WHITE}" : "${headPng}", "base64"));
console.log(JSON.stringify({ bugPresent: base, measure: { u }, highlights: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.5, label: base ? "wrong" : "fixed" }] }));`;

const BASE = "http://127.0.0.1:1/base";
const HEAD = "http://127.0.0.1:2/head";

async function setup(files: Record<string, string>, manifest?: unknown) {
  const dir = await tmp();
  for (const [f, body] of Object.entries(files)) await writeFile(path.join(dir, f), body);
  if (manifest !== undefined) await writeFile(path.join(dir, "scenarios.json"), JSON.stringify(manifest));
  const frames = await tmp();
  return { verifyDir: dir, baseUrl: BASE, headUrl: HEAD, frameDir: frames, logDir: dir };
}

describe("parseScenarios", () => {
  it("keeps valid entries, makes ids unique, caps at three, strips paths", () => {
    const out = parseScenarios([
      { id: "menu", file: "../evil/menu.cjs", title: "Menu opens under the panel", symptomIndex: 1 },
      { id: "menu", file: "second.cjs" },
      { file: "third.cjs", title: "Third" },
      { file: "fourth.cjs" },
      { file: "not-js.txt" },
      "junk",
    ]);
    expect(out.map((s) => s.id)).toEqual(["menu", "menu-2", "third"]);
    expect(out[0]).toMatchObject({ file: "menu.cjs", symptomIndex: 1 });
    expect(out[1].title).toBe("second.cjs"); // title falls back to the file name
  });

  it("accepts {scenarios: [...]} and rejects anything else", () => {
    expect(parseScenarios({ scenarios: [{ file: "a.cjs" }] })).toHaveLength(1);
    expect(parseScenarios({})).toEqual([]);
    expect(parseScenarios(null)).toEqual([]);
  });
});

describe("loadScenarios", () => {
  it("falls back to the legacy single repro.cjs, and to nothing", async () => {
    const legacy = await setup({ "repro.cjs": script(DARK) });
    expect(await loadScenarios(legacy.verifyDir, "Fixed behaviour")).toEqual([{ id: "main", file: "repro.cjs", title: "Fixed behaviour" }]);
    expect(await loadScenarios(await tmp())).toEqual([]);
  });

  it("prefers a valid manifest and ignores a broken one", async () => {
    const ok = await setup({ "a.cjs": script(DARK) }, [{ id: "a", file: "a.cjs", title: "A" }]);
    expect((await loadScenarios(ok.verifyDir)).map((s) => s.id)).toEqual(["a"]);
    const bad = await setup({ "repro.cjs": script(DARK) });
    await writeFile(path.join(bad.verifyDir, "scenarios.json"), "{ not json");
    expect((await loadScenarios(bad.verifyDir)).map((s) => s.id)).toEqual(["main"]);
  });
});

describe("confirmScenarios", () => {
  it("confirms each scenario on its own and marks which ones show a visible difference", async () => {
    const o = await setup(
      { "layer.cjs": script(DARK), "menu.cjs": script(WHITE) },
      [{ id: "layer", file: "layer.cjs", title: "Toolbar over the panel" }, { id: "menu", file: "menu.cjs", title: "Menu under the panel", symptomIndex: 1 }]
    );
    const r = await confirmScenarios(o);
    expect(r.map((x) => [x.scenario.id, x.outcome.ok, x.visible, x.identical])).toEqual([
      ["layer", true, true, false],
      ["menu", true, false, true], // passes the contract but BASE and HEAD frames are the same
    ]);
  });

  it("names every problem when frames are identical, with what to do about it", async () => {
    const o = await setup({ "menu.cjs": script(WHITE) }, [{ id: "menu", file: "menu.cjs", title: "Menu under the panel" }]);
    const problems = scenarioProblems(await confirmScenarios(o));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/pixel-identical/);
    expect(problems[0]).toMatch(/END in the state where the problem is visible/);
  });

  it("reports an empty folder as a problem rather than silently passing", () => {
    expect(scenarioProblems([])[0]).toMatch(/No scenario script was written/);
  });
});

describe("confirmScenariosWithRepair", () => {
  it("does not repair (does not pay) when every scenario passes and shows a difference", async () => {
    let calls = 0;
    const o = await setup({ "a.cjs": script(DARK) }, [{ id: "a", file: "a.cjs", title: "A" }]);
    const r = await confirmScenariosWithRepair(o, async () => void calls++);
    expect(calls).toBe(0);
    expect(r.repaired).toBe(false);
  });

  it("gives ONE repair covering all problems at once, then re-confirms", async () => {
    const o = await setup(
      { "a.cjs": script(DARK), "b.cjs": script(WHITE) },
      [{ id: "a", file: "a.cjs", title: "A" }, { id: "b", file: "b.cjs", title: "B (invisible)" }]
    );
    const prompts: string[] = [];
    const r = await confirmScenariosWithRepair(o, async (prompt) => {
      prompts.push(prompt);
      await writeFile(path.join(o.verifyDir, "b.cjs"), script(DARK)); // Bob makes B visible
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(BASE);
    expect(prompts[0]).toMatch(/"b" \(b\.cjs\) — B \(invisible\)/);
    expect(prompts[0]).not.toMatch(/"a" \(a\.cjs\)/); // only what needs fixing
    expect(r.repaired).toBe(true);
    expect(r.results.every((x) => x.visible)).toBe(true);
  });

  it("stops after one repair even if it did not help", async () => {
    let calls = 0;
    const o = await setup({ "b.cjs": script(WHITE) }, [{ id: "b", file: "b.cjs", title: "B" }]);
    const r = await confirmScenariosWithRepair(o, async () => void calls++);
    expect(calls).toBe(1);
    expect(r.results[0].identical).toBe(true);
  });

  it("without a repair hook it is just the confirmation", async () => {
    const o = await setup({ "b.cjs": script(WHITE) }, [{ id: "b", file: "b.cjs", title: "B" }]);
    expect((await confirmScenariosWithRepair(o)).repaired).toBe(false);
  });
});

describe("buildScenarioRepairPrompt", () => {
  it("gives the live urls, the problems, and the stop rules", () => {
    const p = buildScenarioRepairPrompt({ baseUrl: BASE, headUrl: HEAD, problems: ["- \"x\" broke"] });
    expect(p).toContain(BASE);
    expect(p).toContain("- \"x\" broke");
    expect(p).toMatch(/ONCE against each url/);
    expect(p).toMatch(/remove it from\s+scenarios\.json/);
    expect(p).toMatch(/exit non-zero/);
  });
});

import { inferScenarios } from "./scenarios.js";
import { outOfCredits } from "./bob-verifier.js";
import { plainNoShotsReason } from "./shots-status.js";

describe("inferScenarios (Bob wrote scripts but stopped before scenarios.json)", () => {
  it("uses each non-helper script, titled from its opening comment, ignoring pw.cjs and probes", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "pw.cjs"), "//helper");
    await writeFile(path.join(dir, "probe.cjs"), "// probe");
    await writeFile(path.join(dir, "phone-picker.cjs"), "/**\n * Scenario 0: On a phone the picker stays inside the screen.\n */\nconsole.log(1)");
    await writeFile(path.join(dir, "desktop-align.cjs"), "// Desktop: the picker lines up with its button\nconsole.log(2)");
    const out = await inferScenarios(dir);
    expect(out.map((s) => s.file)).toEqual(["desktop-align.cjs", "phone-picker.cjs"]);
    expect(out[1].title).toBe("On a phone the picker stays inside the screen");
    expect(out[1].symptomIndex).toBe(0);
    expect(out[0].title).toBe("Desktop: the picker lines up with its button");
  });

  it("is what loadScenarios falls back to, and empty for an empty folder", async () => {
    const dir = await tmp();
    expect(await loadScenarios(dir)).toEqual([]);
    await writeFile(path.join(dir, "only.cjs"), "// The only scenario here\n");
    expect((await loadScenarios(dir)).map((s) => s.id)).toEqual(["only"]);
  });
});

describe("Bob out of credits", () => {
  it("recognises the service's message and not ordinary errors", () => {
    expect(outOfCredits("Error: Time to go beyond the trial. Looks like you've put all the trial Bobcoins to good use! Unlock more BobCoins")).toBe(true);
    expect(outOfCredits("Error: usage limit reached for your plan")).toBe(true);
    expect(outOfCredits("locator .sidebar timed out")).toBe(false);
    expect(outOfCredits("")).toBe(false);
  });

  it("is shown to the reader as a plain sentence, not as a script failure", () => {
    expect(plainNoShotsReason("the screenshot tool has no credits left")).toMatch(/out of credits/);
  });
});
