import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Walkthrough } from "@pr-walkthrough/shared";

import { formatReport, reportFailed, reportWalkthrough } from "./run-report.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (n: number): Walkthrough =>
  JSON.parse(readFileSync(path.join(HERE, `../api/__fixtures__/excalidraw-${n}.live.json`), "utf-8"));

describe("reportWalkthrough", () => {
  it("the accepted live result of #10943 passes", () => {
    const lines = reportWalkthrough(load(10943));
    expect(reportFailed(lines), formatReport(lines)).toBe(false);
  });

  it("the live #10295 run fails on exactly what the comparison with the reference found", () => {
    const failed = reportWalkthrough(load(10295)).filter((l) => !l.ok && l.level === "fail");
    expect(failed.map((l) => l.check)).toEqual(["no critical quality warnings"]);
    expect(failed[0].detail).toBe("s1: narration-too-long; s3: thinking-aloud; s6: narration-too-long");
  });

  it("fails a silent screenshot gap", () => {
    const wt = load(10295);
    delete wt.verification;
    expect(reportFailed(reportWalkthrough(wt))).toBe(true);
  });

  it("fails an internal error shown as the no-screenshots reason", () => {
    const wt = load(10295);
    delete wt.shots;
    wt.verification = { status: "skipped", scenario: [], skipReason: "Error: yarn exited with code 1 at start (app-servers.ts:88)" };
    const failed = reportWalkthrough(wt).filter((l) => !l.ok && l.level === "fail").map((l) => l.check);
    expect(failed).toContain("no-screenshots reason is plain words");
  });

  it("fails a measured step that lost its verdict", () => {
    const wt = load(10295);
    for (const s of wt.steps) delete s.evidence;
    expect(reportFailed(reportWalkthrough(wt))).toBe(true);
  });

  it("fails a critical quality warning", () => {
    const wt = load(10295);
    wt.steps[1].headline = "This headline is much too long for the reader and the voice to follow";
    expect(reportFailed(reportWalkthrough(wt))).toBe(true);
  });
});
