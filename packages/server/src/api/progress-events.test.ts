import { describe, it, expect } from "vitest";
import type { Hunk } from "@pr-walkthrough/shared";

import { planEvent, filesEvent, scenarioEvent, skippedOutcome, confirmedEvents, shotsNotPlannedReason } from "./progress-events.js";
import { IDENTICAL_FRAMES_NOTE } from "../verify/shots-status.js";

const hunk = (file: string, i: number, added: number, removed: number): Hunk => ({ id: `${file}#${i}`, file, header: "@@", added, removed });

describe("planEvent", () => {
  const pr = { title: "fix: x", additions: 10, deletions: 2, filesChanged: 3 };
  it("plans screenshots for a repo with an app recipe", () => {
    expect(planEvent(5, pr, undefined)).toEqual({
      kind: "plan", t: 5, pr: { title: "fix: x", additions: 10, deletions: 2, files: 3 }, shots: { planned: true },
    });
  });
  it("says in a sentence why they are not planned", () => {
    const why = shotsNotPlannedReason(false, false, "acme/widgets");
    expect(why).toMatch(/isn't set up for automatic screenshots/);
    expect(planEvent(5, pr, why).shots).toEqual({ planned: false, reason: why });
    expect(shotsNotPlannedReason(true, true, "acme/widgets")).toMatch(/turned off/);
    expect(shotsNotPlannedReason(true, false, "acme/widgets")).toBeUndefined();
  });
});

describe("filesEvent", () => {
  it("sums hunks per file and marks a file skipped only when all its hunks were", () => {
    const hunks = [hunk("a.ts", 1, 5, 1), hunk("a.ts", 2, 2, 0), hunk("yarn.lock", 1, 40, 30), hunk("b.ts", 1, 1, 1)];
    const e = filesEvent(9, hunks, [{ hunkId: "yarn.lock#1", reason: "lockfile" }, { hunkId: "b.ts#1", reason: "x" }, { hunkId: "zzz#1", reason: "unrelated" }]);
    expect(e.files).toEqual([
      { path: "a.ts", additions: 7, deletions: 1, skipped: false },
      { path: "yarn.lock", additions: 40, deletions: 30, skipped: true },
      { path: "b.ts", additions: 1, deletions: 1, skipped: true },
    ]);
  });
  it("a file with one of two hunks skipped is still shown as read", () => {
    const e = filesEvent(1, [hunk("a.ts", 1, 1, 0), hunk("a.ts", 2, 1, 0)], [{ hunkId: "a.ts#1", reason: "x" }]);
    expect(e.files[0]?.skipped).toBe(false);
  });
});

describe("scenarioEvent", () => {
  it("drops blanks and is absent when there is nothing to try", () => {
    expect(scenarioEvent(1, ["  Open the menu ", "", "Check the picker"])?.lines).toEqual(["Open the menu", "Check the picker"]);
    expect(scenarioEvent(1, [])).toBeUndefined();
    expect(scenarioEvent(1, undefined)).toBeUndefined();
  });
});

describe("outcomes", () => {
  it("maps a raw verifier failure to a code and a plain sentence", () => {
    const e = skippedOutcome(3, "yarn install timed out after 600s: ENOSPC");
    expect(e).toMatchObject({ kind: "outcome", what: "shots", code: "app-failed" });
    expect(e.message).not.toMatch(/yarn|ENOSPC|600s/);
  });
  it("keeps a reason the verifier wrote in plain words as is (nothing to see)", () => {
    expect(skippedOutcome(3, "The change only affects server-side rendering.", { alreadyPlain: true })).toMatchObject({
      code: "non-visual", message: "The change only affects server-side rendering.",
    });
  });
  it("confirmed repro with frames: frames first, then ok", () => {
    const evs = confirmedEvents(7, { before: { src: "before-annotated.png" }, after: { src: "after-annotated.png" }, caption: "c" }, undefined);
    expect(evs.map((e) => e.kind)).toEqual(["frames", "outcome"]);
    expect(evs[0]).toMatchObject({ before: "before-annotated.png", after: "after-annotated.png", caption: "c" });
    expect(evs[1]).toMatchObject({ code: "ok" });
  });
  it("confirmed repro without frames is 'identical' with the note", () => {
    const evs = confirmedEvents(7, undefined, IDENTICAL_FRAMES_NOTE);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "outcome", code: "identical", message: IDENTICAL_FRAMES_NOTE });
  });
});
