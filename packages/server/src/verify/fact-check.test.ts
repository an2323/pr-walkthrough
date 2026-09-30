import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Walkthrough } from "@pr-walkthrough/shared";

import { buildFactCheckPrompt, mergeProse, NO_CHANGES } from "./fact-check.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (): Walkthrough => JSON.parse(readFileSync(path.join(HERE, "../api/__fixtures__/excalidraw-10295.live.json"), "utf-8"));

// What the #10295 mobile scenario measured on BASE (probe on the VM, Sep 30).
const FACT = {
  id: "sidebar-mobile-menu",
  title: "Opening main menu closes the sidebar on mobile",
  symptomIndex: 1,
  base: { sidebarStillVisible: true, elementOnTopAtSidebar: { inSidebar: false, inMenu: true }, cssVarLibrary: 80, cssVarTop: 100 },
  head: { sidebarStillVisible: false, cssVarLibrary: 120, cssVarTop: 100 },
};

describe("buildFactCheckPrompt", () => {
  it("shows every measurement and the text to check, and how to say 'nothing to fix'", () => {
    const p = buildFactCheckPrompt(load(), [FACT]);
    expect(p).toContain('"inMenu":true');
    expect(p).toContain("plain.problem:");
    expect(p).toContain("[1] On phones");
    expect(p).toContain(NO_CHANGES);
  });
});

describe("mergeProse — only prose comes from the answer", () => {
  it("takes corrected sentences, keeps code, frames, verdicts and structure", () => {
    const wt = load();
    const answer = JSON.parse(JSON.stringify(wt)) as Record<string, any>;
    answer.plain.problem = "Opening the main menu left the sidebar open underneath it.";
    answer.steps[0].visual.items[1] = "Opening the main menu leaves the sidebar open too";
    // Things a fact check must never be able to change:
    answer.steps[2].beats = [];
    answer.steps[2].hunkIds = [];
    answer.shots = undefined;
    answer.steps.push({ id: "s99", kind: "change", narration: "new" });

    const { walkthrough: out, changed } = mergeProse(wt, answer);
    expect(changed).toEqual(["plain.problem", "s1.symptom[1]"]);
    expect(out.plain!.problem).toMatch(/left the sidebar open/);
    const item = (out.steps[0].visual as { items: { text: string; src?: string }[] }).items[1];
    expect(item).toEqual({ text: "Opening the main menu leaves the sidebar open too", src: "symptom-1-annotated.png" });
    expect(out.steps[2].beats).toEqual(wt.steps[2].beats);
    expect(out.steps[2].hunkIds).toEqual(wt.steps[2].hunkIds);
    expect(out.steps[2].evidence).toEqual(wt.steps[2].evidence);
    expect(out.shots).toEqual(wt.shots);
    expect(out.steps.map((s) => s.id)).toEqual(wt.steps.map((s) => s.id));
  });

  it("an identical answer changes nothing", () => {
    const wt = load();
    expect(mergeProse(wt, JSON.parse(JSON.stringify(wt))).changed).toEqual([]);
  });
});
