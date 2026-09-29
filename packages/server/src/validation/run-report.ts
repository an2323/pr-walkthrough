/**
 * run-report.ts — the acceptance check for a FINISHED walkthrough, as a reader would meet it.
 *
 * Paid runs used to be judged by eye after the fact ("no warnings? frames there?"), and a gap was
 * found only when someone happened to look. This turns the rubric into code: the same checks run
 * after every rehearsal and every real run (scripts/check-run.ts), and a run is "done" only when
 * this report has no FAIL. Pure — the script adds the HTTP checks (frames and audio reachable).
 */

import type { Walkthrough } from "@pr-walkthrough/shared";

import { verdictForStep } from "../verify/ablation.js";
import { checkQuality, criticalQualityWarnings } from "./quality.js";
import { validateSchema } from "./schema.js";

export interface ReportLine {
  ok: boolean;
  /** "fail" blocks calling the run done; "warn" is worth a look but not a blocker. */
  level: "fail" | "warn";
  check: string;
  detail?: string;
}

/** Internal error text that must never reach a reader as the "why no screenshots" sentence. */
const INTERNAL = /\b(error|ENOENT|EACCES|exited with|stack|undefined|null|at [\w.]+ \(|\.cjs|\.ts:\d+|http:\/\/127)/i;

export function reportWalkthrough(wt: Walkthrough): ReportLine[] {
  const out: ReportLine[] = [];
  const add = (ok: boolean, check: string, detail?: string, level: "fail" | "warn" = "fail") =>
    out.push({ ok, level, check, ...(detail ? { detail } : {}) });

  const schema = validateSchema(wt);
  add(schema.valid, "schema-valid", schema.errors.slice(0, 3).join("; ") || undefined);

  const uncovered = wt.coverage?.uncoveredHunkIds ?? [];
  add(uncovered.length === 0, "every hunk explained or skipped", uncovered.join(", ") || undefined);

  const warnings = checkQuality(wt);
  const critical = criticalQualityWarnings(warnings);
  add(critical.length === 0, "no critical quality warnings", critical.map((w) => `${w.stepId ?? "-"}: ${w.code}`).join("; ") || undefined);
  const soft = warnings.filter((w) => !critical.includes(w));
  add(soft.length === 0, "no soft quality warnings", soft.map((w) => w.code).join(", ") || undefined, "warn");

  add(!!wt.meta?.run?.taskId, "run stats recorded (meta.run)", undefined, "warn");

  const v = wt.verification;
  if (!v) {
    add(false, "screenshot outcome stated", "verification missing — a silent gap");
  } else if (v.status === "passed") {
    add(!!wt.shots || !!v.shotsNote, "verified: frames or an honest note", wt.shots ? "before/after pair" : v.shotsNote);
    add(!v.skipReason, "no stale 'no screenshots' reason on a verified run", v.skipReason);
  } else {
    const reason = v.skipReason ?? "";
    add(reason.length > 10, "no-screenshots reason given", reason || "empty");
    add(!INTERNAL.test(reason), "no-screenshots reason is plain words", reason);
    add(!/didn't finish/.test(reason), "screenshot step finished", reason, "fail");
    add(!wt.shots, "no frames on a skipped verification");
  }

  const symptoms = wt.steps.find((s) => !s.minor && s.visual?.type === "symptoms");
  if (symptoms?.visual?.type === "symptoms" && v?.status === "passed") {
    const withFrames = symptoms.visual.items.filter((i) => typeof i !== "string" && !!i.src).length;
    add(withFrames > 0, "symptom cards have frames", `${withFrames}/${symptoms.visual.items.length}`, "warn");
  }

  const ablation = v?.ablation;
  if (ablation) {
    const missing = wt.steps.filter((s) => verdictForStep(ablation, s.hunkIds) && !s.evidence).map((s) => s.id);
    add(missing.length === 0, "ablation verdict on every measured step", missing.join(", ") || undefined);
  }

  const silent = wt.steps.filter((s) => !s.narration?.trim()).map((s) => s.id);
  add(silent.length === 0, "every step has narration (audio)", silent.join(", ") || undefined);
  return out;
}

export function reportFailed(lines: ReportLine[]): boolean {
  return lines.some((l) => !l.ok && l.level === "fail");
}

export function formatReport(lines: ReportLine[]): string {
  return lines
    .map((l) => `${l.ok ? "PASS" : l.level === "fail" ? "FAIL" : "WARN"}  ${l.check}${l.detail ? ` — ${l.detail}` : ""}`)
    .join("\n");
}
