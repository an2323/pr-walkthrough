import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { Walkthrough } from "@pr-walkthrough/shared";

import { buildFactCheckPrompt, mergeProse } from "./fact-check.js";
import { readUnchanged, removeSymptoms, symptomsToDrop, UNCHANGED_FILE } from "./unchanged-symptoms.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** #10295's walkthrough with a third, picture-less symptom like #10199's "hidden behind the properties popup". */
const load = (): Walkthrough => {
  const wt = JSON.parse(readFileSync(path.join(HERE, "../api/__fixtures__/excalidraw-10295.live.json"), "utf-8")) as Walkthrough;
  (wt.steps[0].visual as { items: unknown[] }).items.push({ text: "The menu is hidden behind the properties popup" });
  return wt;
};
const items = (wt: Walkthrough) => (wt.steps[0].visual as { items: { text: string; src?: string }[] }).items;
const WHY = "popup 40 > menu 10 at BASE, popup 100 > menu 90 at HEAD";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("readUnchanged", () => {
  it("reads the verifier's list and ignores malformed entries", async () => {
    const d = await mkdtemp(path.join(tmpdir(), "unchanged-"));
    dirs.push(d);
    expect(readUnchanged(d)).toEqual([]);
    await writeFile(path.join(d, UNCHANGED_FILE), JSON.stringify([{ symptomIndex: 2, why: WHY }, { symptomIndex: 2, why: "dup" }, { symptomIndex: "x" }, { index: 1 }]));
    expect(readUnchanged(d)).toEqual([{ symptomIndex: 2, why: WHY }]);
  });
});

describe("symptomsToDrop / removeSymptoms (#10199)", () => {
  it("removes a picture-less symptom the PR doesn't change, after the fact check saw it", () => {
    const wt = load();
    const drop = symptomsToDrop(wt, [{ symptomIndex: 2, why: WHY }]);
    expect(drop).toEqual([{ index: 2, of: 3, text: "The menu is hidden behind the properties popup", why: WHY }]);
    expect(items(wt)).toHaveLength(3); // nothing removed yet

    const prompt = buildFactCheckPrompt(wt, [], drop);
    expect(prompt).toContain("Not changed by this PR");
    expect(prompt).toContain(`"The menu is hidden behind the properties popup" — ${WHY}`);

    removeSymptoms(wt, drop);
    expect(items(wt).map((i) => i.src)).toEqual(["symptom-0-annotated.png", "symptom-1-annotated.png"]);
  });

  it("never drops a symptom with a picture, nor the whole list", () => {
    const wt = load();
    expect(symptomsToDrop(wt, [{ symptomIndex: 0, why: WHY }])).toEqual([]);
    const two = load();
    items(two).splice(0, 2, { text: "Only one" });
    expect(symptomsToDrop(two, [{ symptomIndex: 0, why: WHY }, { symptomIndex: 1, why: WHY }])).toEqual([]);
  });

  it("removes nothing if the list changed size since it was planned", () => {
    const wt = load();
    const drop = symptomsToDrop(wt, [{ symptomIndex: 2, why: WHY }]);
    items(wt).pop();
    removeSymptoms(wt, drop);
    expect(items(wt)).toHaveLength(2);
  });

  it("a fact-check answer with a different number of symptoms leaves their texts alone (no misaligned merge)", () => {
    const wt = load();
    const answer = JSON.parse(JSON.stringify(wt)) as Record<string, any>;
    answer.steps[0].visual.items.splice(1, 1);
    answer.plain.problem = "The menu could open behind the sidebar.";
    const { walkthrough: out, changed } = mergeProse(wt, answer);
    expect(changed).toEqual(["plain.problem"]);
    expect(items(out)).toEqual(items(wt));
  });
});
