/**
 * recording-enrich.ts — lets a recording made before the structured progress events existed play on the
 * current analysis screen. Everything it adds is read from the finished walkthrough of that very run (the PR,
 * its hunks, the scenario, the frames, why there are none) and placed where the pipeline itself would have
 * emitted it; nothing is invented. A recording that already has a `plan` event is returned untouched.
 */

import type { Hunk, ProgressEvent, Walkthrough } from "@pr-walkthrough/shared";

import { confirmedEvents, filesEvent, planEvent, scenarioEvent, shotsNotPlannedReason, skippedOutcome } from "./progress-events.js";

const VERIFIER_DONE = /^(Screenshots taken by Bob|Bug reproduced|Screenshots skipped|Screenshots failed|Screenshots couldn't)/;

type Stage = Extract<ProgressEvent, { kind: "stage" }>;

function stageIndex(events: ProgressEvent[], test: (s: Stage) => boolean, from = 0): number {
  for (let i = from; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "stage" && test(e)) return i;
  }
  return -1;
}

export function enrichRecording(events: ProgressEvent[], wt: Walkthrough | null, appCanRun: boolean): ProgressEvent[] {
  if (!wt || events.length === 0 || events.some((e) => e.kind === "plan")) return events;

  // Insert `ev` right after index `after` (its time is that event's time, so the order in time is kept).
  const inserts = new Map<number, ProgressEvent[]>();
  const put = (after: number, ev: ProgressEvent | ProgressEvent[] | undefined): void => {
    if (!ev) return;
    const list = inserts.get(after) ?? [];
    list.push(...(Array.isArray(ev) ? ev : [ev]));
    inserts.set(after, list);
  };
  const t = (i: number): number => events[Math.max(0, i)]!.t;

  const ranShots = events.some((e) => e.kind === "stage" && (e.stage === "app" || e.stage === "shots"));
  const planned = appCanRun;
  const notPlannedReason = planned ? undefined : shotsNotPlannedReason(false, false, wt.pr.repo);

  const first = stageIndex(events, () => true);
  const at0 = first >= 0 ? first : 0;
  put(at0, planEvent(t(at0), wt.pr, notPlannedReason));

  const hunks = stageIndex(events, (s) => s.stage === "hunks");
  put(hunks >= 0 ? hunks : at0, filesEvent(t(hunks >= 0 ? hunks : at0), wt.hunks as Hunk[], wt.skippedHunks ?? []));

  if (planned) {
    const validating = stageIndex(events, (s) => s.stage === "validating");
    if (validating >= 0) put(validating, scenarioEvent(t(validating), wt.verification?.scenario));
  }

  // The screenshot verdict goes where the verifier reported it; with no such stage, before the end.
  const verdictAt = stageIndex(events, (s) => (s.stage === "shots" || s.stage === "app") && VERIFIER_DONE.test(s.label));
  const v = wt.verification;
  const verdict: ProgressEvent[] | undefined =
    v?.status === "passed"
      ? confirmedEvents(0, wt.shots, v.shotsNote)
      : v?.skipReason
        ? [skippedOutcome(0, v.skipReason, { alreadyPlain: true })]
        : undefined;
  if (verdict) {
    const doneAt = events.findIndex((e) => e.kind === "done" || e.kind === "error");
    let anchor = verdictAt;
    if (anchor < 0) {
      if (ranShots) anchor = stageIndex(events, (s) => s.stage === "shots" && /Testing which changes|Measured/.test(s.label)) - 1;
      if (anchor < 0) anchor = (doneAt >= 0 ? doneAt : events.length) - 1;
    }
    put(anchor, verdict.map((e) => ({ ...e, t: t(anchor) }) as ProgressEvent));
  }

  const out: ProgressEvent[] = [];
  events.forEach((e, i) => {
    out.push(e);
    for (const extra of inserts.get(i) ?? []) out.push({ ...extra, t: e.t } as ProgressEvent);
  });
  return out;
}
