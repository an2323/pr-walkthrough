import { describe, it, expect } from "vitest";
import type { Walkthrough } from "@pr-walkthrough/shared";

import { plainNoShotsReason, shotsOutcomeCode, recordNoShots, recordShotsNote, markVerified, IDENTICAL_FRAMES_NOTE } from "./shots-status.js";

const wt = (verification?: Walkthrough["verification"]) => ({ verification }) as Walkthrough;

describe("plainNoShotsReason", () => {
  it("turns internal reasons into sentences a reviewer can read", () => {
    expect(plainNoShotsReason("no app recipe for acme/widgets")).toMatch(/isn't set up for automatic screenshots/);
    expect(plainNoShotsReason("screenshots turned off (VERIFY_SHOTS=0)")).toMatch(/turned off/);
    expect(plainNoShotsReason("title suggests a non-visual change (perf: cache) and no UI files in the diff")).toMatch(/nothing to see/);
    expect(plainNoShotsReason("walkthrough has no base/head SHA")).toMatch(/commits/);
  });

  it("hides technical repro failures behind one honest sentence", () => {
    for (const raw of [
      "repro.cjs failed on BASE: Timeout 30000ms exceeded",
      "repro.cjs says the bug is already absent on BASE — not trusted",
      "Bob did not write repro.cjs",
    ]) {
      const out = plainNoShotsReason(raw);
      expect(out).toMatch(/couldn't be reproduced reliably/);
      expect(out).not.toMatch(/repro\.cjs|BASE|Timeout/);
    }
  });

  it("keeps a reason the verifier wrote in plain words, trimmed to a sane length", () => {
    expect(plainNoShotsReason("The change only affects server-side rendering.")).toBe("The change only affects server-side rendering.");
    const long = plainNoShotsReason("Only touches a rarely visible tooltip. ".repeat(20));
    expect(long.length).toBeLessThanOrEqual(220);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("recordNoShots / recordShotsNote", () => {
  it("marks verification skipped and keeps the analyzer's scenario", () => {
    const w = wt({ status: "not_run", scenario: ["Open the menu → the panel closes"] });
    recordNoShots(w, "no app recipe for acme/widgets");
    expect(w.verification).toMatchObject({
      status: "skipped",
      scenario: ["Open the menu → the panel closes"],
    });
    expect(w.verification?.skipReason).toMatch(/isn't set up/);
  });

  it("creates a verification block when the analyzer gave none", () => {
    const w = wt();
    recordNoShots(w, "screenshots couldn't be captured this time.", { alreadyPlain: true });
    expect(w.verification).toEqual({
      status: "skipped",
      scenario: [],
      skipReason: "screenshots couldn't be captured this time.",
    });
  });

  it("adds a note without changing a measured status", () => {
    const w = wt({ status: "passed", scenario: [] });
    recordShotsNote(w, IDENTICAL_FRAMES_NOTE);
    expect(w.verification).toMatchObject({ status: "passed", shotsNote: IDENTICAL_FRAMES_NOTE });
  });
});

describe("pre-flight and startup reasons", () => {
  it("explains a missing screenshot tool or unset key without naming internals", () => {
    expect(plainNoShotsReason("the screenshot tool (bob) isn't available on this server")).toMatch(/screenshot tool isn't available/);
    expect(plainNoShotsReason("the screenshot tool isn't configured on this server (no BOB_API_KEY)")).toMatch(/screenshot tool isn't available/);
  });

  it("says the app couldn't be started for warm-up, dev-server, install and disk problems — not that the bug wasn't reproduced", () => {
    for (const raw of [
      "warm-up failed for http://127.0.0.1:41013/: Timeout 120000ms exceeded",
      "dev server exited early (code 1): EADDRINUSE",
      "Timed out waiting for http://127.0.0.1:5000/: compiling",
      "yarn install --frozen-lockfile timed out after 900s: network",
      "only 2.1 GB free — need 8 GB to install the app",
    ]) {
      const out = plainNoShotsReason(raw);
      expect(out, raw).toMatch(/couldn't be started here/);
      expect(out).not.toMatch(/yarn|127\.0|EADDR|GB/);
    }
  });

  it("keeps a spending-limit reason as written", () => {
    expect(plainNoShotsReason("the spending limit for analyses has been reached")).toBe("the spending limit for analyses has been reached");
  });
});

describe("markVerified", () => {
  it("replaces a 'didn't finish' placeholder with a passed status and drops the stale reason", () => {
    const w = wt();
    recordNoShots(w, "the screenshot step didn't finish.", { alreadyPlain: true });
    markVerified(w);
    expect(w.verification).toEqual({ status: "passed", scenario: [] });
  });

  it("keeps the scenario and any ablation already recorded", () => {
    const w = wt({ status: "skipped", scenario: ["Open the menu"], skipReason: "old", ablation: { units: ["a"], runs: [] } } as never);
    markVerified(w);
    expect(w.verification).toMatchObject({ status: "passed", scenario: ["Open the menu"], ablation: { units: ["a"] } });
    expect(w.verification?.skipReason).toBeUndefined();
  });
});

describe("shotsOutcomeCode", () => {
  it("classifies every ending the progress screen has a card for", () => {
    expect(shotsOutcomeCode("no app recipe for acme/widgets")).toBe("no-recipe");
    expect(shotsOutcomeCode("title suggests a non-visual change (perf: cache) and no UI files in the diff")).toBe("non-visual");
    expect(shotsOutcomeCode("yarn install timed out after 600s")).toBe("app-failed");
    expect(shotsOutcomeCode("dev server didn't start on 127.0.0.1:5173")).toBe("app-failed");
    expect(shotsOutcomeCode("repro.cjs says the bug is already absent on BASE — not trusted")).toBe("not-reproduced");
    expect(shotsOutcomeCode("Bob did not write repro.cjs")).toBe("not-reproduced");
    expect(shotsOutcomeCode("screenshots turned off (VERIFY_SHOTS=0)")).toBe("unavailable");
    expect(shotsOutcomeCode("no credits left for the screenshot tool")).toBe("unavailable");
  });

  it("treats a reason the verifier wrote in plain words as 'nothing to see'", () => {
    expect(shotsOutcomeCode("The change only affects server-side rendering.")).toBe("non-visual");
  });

  it("agrees with plainNoShotsReason on the same input", () => {
    // app-failed and not-reproduced must map to the same sentences plainNoShotsReason gives them.
    expect(plainNoShotsReason("yarn install timed out after 600s")).toMatch(/couldn't be started/);
    expect(plainNoShotsReason("repro.cjs failed on BASE: Timeout")).toMatch(/couldn't be reproduced/);
  });
});
