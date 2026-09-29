import { describe, expect, it } from "vitest";

import { plainJobError } from "./plain-error.js";

describe("plainJobError", () => {
  it.each([
    ["Bob has no credits left: Time to go beyond the trial… all the trial Bobcoins", /out of credits/],
    ["Budget guard: $39.10 already spent this stage + this run's max-cost $4.9 would exceed the $40.6 cap.", /spending limit/],
    ["BobShellAnalyzer: no walkthrough found in bob output. exit=0 task=abc stderr=…", /couldn't be read/],
    ["Validation failed: steps.0.narration: Required", /didn't pass the checks.*narration/],
    ["GitHub API error 404: Not Found", /couldn't be fetched from GitHub/],
    ["git worktree add failed: fatal: …", /couldn't be checked out/],
  ])("%s", (raw, want) => {
    expect(plainJobError(raw)).toMatch(want);
  });

  it("keeps an unknown error to its first line", () => {
    expect(plainJobError("Something odd\n    at foo (bar.ts:1)")).toBe("Something odd");
  });
});
