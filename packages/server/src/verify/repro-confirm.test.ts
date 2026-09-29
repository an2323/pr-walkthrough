import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRepairPrompt, confirmRepro, confirmWithRepair, type ConfirmOptions } from "./repro-confirm.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const BASE = "http://127.0.0.1:1111/base";
const HEAD = "http://127.0.0.1:2222/head";

/** A repro whose answer depends on the url, like a real one measures the running build. */
const GOOD = `const u = process.argv[2]; console.log(JSON.stringify({ bugPresent: u.includes("base"), measure: { url: u, found: true }, highlights: [] }));`;
/** The failure seen in the first live run: "found nothing" reported as "no bug". */
const VACUOUS_FALSE = `console.log(JSON.stringify({ bugPresent: false, measure: { sidebarFound: false }, highlights: [] }));`;
const CRASH = `console.error("locator .sidebar timed out"); process.exit(1);`;

async function setup(script: string | null): Promise<ConfirmOptions> {
  const dir = await mkdtemp(path.join(tmpdir(), "repro-confirm-"));
  dirs.push(dir);
  const reproPath = path.join(dir, "repro.cjs");
  if (script !== null) await writeFile(reproPath, script);
  return { reproPath, baseUrl: BASE, headUrl: HEAD, cwd: dir, beforePng: path.join(dir, "b.png"), afterPng: path.join(dir, "a.png"), logDir: dir };
}

describe("confirmRepro (the contract)", () => {
  it("accepts a script that says true on BASE and false on HEAD", async () => {
    const r = await confirmRepro(await setup(GOOD));
    expect(r.ok).toBe(true);
    expect(r.before).toMatchObject({ bugPresent: true });
    expect(r.after).toMatchObject({ bugPresent: false });
  });

  it("rejects the vacuous 'false on BASE' as a wrong answer (kind: wrong)", async () => {
    const r = await confirmRepro(await setup(VACUOUS_FALSE));
    expect(r).toMatchObject({ ok: false, kind: "wrong" });
    expect(r.problem).toMatch(/already absent on BASE/);
  });

  it("rejects a script that still sees the bug on HEAD", async () => {
    const r = await confirmRepro(await setup(`console.log(JSON.stringify({ bugPresent: true, measure: {}, highlights: [] }));`));
    expect(r).toMatchObject({ ok: false, kind: "wrong" });
    expect(r.problem).toMatch(/still says the bug is present on HEAD/);
  });

  it("calls a crash an error (not a wrong answer), keeps its stderr, and retries a run once", async () => {
    const o = await setup(CRASH);
    const r = await confirmRepro(o);
    expect(r).toMatchObject({ ok: false, kind: "error" });
    expect(r.problem).toMatch(/failed on BASE.*locator \.sidebar timed out/s);
    expect(existsSync(path.join(o.logDir!, "repro-error.txt"))).toBe(true);
  });

  it("retries a transient run error once and then passes", async () => {
    const o = await setup(null);
    const flaky = `
      const fs = require("fs"); const marker = ${JSON.stringify(path.join(o.cwd, "seen"))};
      const u = process.argv[2];
      if (u.includes("base") && !fs.existsSync(marker)) { fs.writeFileSync(marker, "1"); console.error("Target closed"); process.exit(1); }
      console.log(JSON.stringify({ bugPresent: u.includes("base"), measure: {}, highlights: [] }));`;
    await writeFile(o.reproPath, flaky);
    expect((await confirmRepro(o)).ok).toBe(true);
  });

  it("a missing file is an error", async () => {
    const r = await confirmRepro(await setup(null));
    expect(r).toMatchObject({ ok: false, kind: "error", problem: "Bob did not write repro.cjs" });
  });
});

describe("buildRepairPrompt", () => {
  it("gives Bob the real outputs, the NEW urls and the rules, and forbids more exploring", async () => {
    const o = await setup(VACUOUS_FALSE);
    const outcome = await confirmRepro(o);
    const p = buildRepairPrompt({ baseUrl: BASE, headUrl: HEAD, outcome });
    expect(p).toContain(BASE);
    expect(p).toContain(HEAD);
    expect(p).toContain('"sidebarFound":false'); // what its script really printed
    expect(p).toMatch(/already absent on BASE/);
    expect(p).toMatch(/exit non-zero/);
    expect(p).toMatch(/Do not explore further/);
    expect(p).toMatch(/ONCE against each url/);
    expect(p).toMatch(/skip\.json/);
  });

  it("shows a crash as FAILED with its message", async () => {
    const outcome = await confirmRepro(await setup(CRASH));
    expect(buildRepairPrompt({ baseUrl: BASE, headUrl: HEAD, outcome })).toMatch(/FAILED: .*locator \.sidebar timed out/);
  });
});

describe("confirmWithRepair", () => {
  it("does not repair (and does not pay) when the first confirmation passes", async () => {
    let calls = 0;
    const r = await confirmWithRepair(await setup(GOOD), { repair: async () => void calls++ });
    expect(r).toMatchObject({ repaired: false });
    expect(r.outcome.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it("gives exactly one chance: repairs a wrong script, then passes", async () => {
    const o = await setup(VACUOUS_FALSE);
    const prompts: string[] = [];
    const r = await confirmWithRepair(o, {
      repair: async (prompt) => {
        prompts.push(prompt);
        await writeFile(o.reproPath, GOOD); // Bob rewrites the file
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/already absent on BASE/);
    expect(r.repaired).toBe(true);
    expect(r.outcome.ok).toBe(true);
    expect(await readFile(o.reproPath, "utf-8")).toBe(GOOD);
  });

  it("stops after one repair even if the script is still wrong", async () => {
    let calls = 0;
    const r = await confirmWithRepair(await setup(VACUOUS_FALSE), { repair: async () => void calls++ });
    expect(calls).toBe(1);
    expect(r.repaired).toBe(true);
    expect(r.outcome.ok).toBe(false);
  });

  it("repairs a crash too, and a missing file", async () => {
    for (const script of [CRASH, null]) {
      const o = await setup(script);
      const r = await confirmWithRepair(o, { repair: async () => void (await writeFile(o.reproPath, GOOD)) });
      expect(r.outcome.ok).toBe(true);
    }
  });

  it("without hooks (no task to resume / no budget) it is just the confirmation", async () => {
    const r = await confirmWithRepair(await setup(VACUOUS_FALSE));
    expect(r.repaired).toBe(false);
    expect(r.outcome.ok).toBe(false);
  });
});
