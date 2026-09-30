/**
 * fact-check.ts — the prose must not contradict what was measured in the running app.
 *
 * The analysis is written from the code and the PR description; the description can be wrong
 * about what the user sees. On #10295 the text said "on mobile the sidebar covers the menu" while
 * the confirmed scenario measured, on BASE, the menu drawn ABOVE the open sidebar (both open at
 * once). Revise only fires on ablation contradictions, so nothing caught it.
 *
 * One cheap resume of the analysis session gets the confirmed scenarios with their BASE/HEAD
 * measurements and rewrites only the sentences a measurement contradicts. Only PROSE is taken
 * from the answer (plain.*, summary.*, headline/say/narration/title, symptom texts) and merged into
 * the current walkthrough — code, hunks, visuals and every backend-owned field stay as they are,
 * so a fact-check can never break verbatim code or coverage.
 */

import type { Walkthrough } from "@pr-walkthrough/shared";

import { findWalkthroughInEvents, runBob } from "../analyzer/bob-shell.js";
import { assertBudget, recordSpend } from "../analyzer/budget.js";
import { validateSchema } from "../validation/schema.js";

const FACTCHECK_MAX_COST = Number(process.env.FACTCHECK_MAX_COST ?? 0.6);
/** A measurement is shown to Bob truncated to this many characters (they can be large objects). */
const MAX_MEASURE_CHARS = 1500;
export const NO_CHANGES = "NO_CHANGES";

/** One confirmed scenario and what its script measured on each build. */
export interface ScenarioFact {
  id: string;
  title: string;
  symptomIndex?: number;
  base: unknown;
  head: unknown;
}

const clip = (v: unknown): string => {
  const s = JSON.stringify(v ?? null);
  return s.length > MAX_MEASURE_CHARS ? `${s.slice(0, MAX_MEASURE_CHARS)}…` : s;
};

export function buildFactCheckPrompt(wt: Walkthrough, facts: ScenarioFact[]): string {
  const symptoms = wt.steps.find((s) => s.visual?.type === "symptoms");
  const symptomItems =
    symptoms?.visual?.type === "symptoms"
      ? symptoms.visual.items.map((i, n) => `  [${n}] ${typeof i === "string" ? i : i.text}`).join("\n")
      : "  (none)";
  const steps = wt.steps
    .filter((s) => !s.minor)
    .map((s) => `- ${s.id} (${s.kind}) headline: "${s.headline ?? s.title}"\n  say: ${s.say ?? ""}\n  narration: ${s.narration ?? ""}`)
    .join("\n");
  const measured = facts
    .map(
      (f) =>
        `- scenario "${f.id}" — ${f.title}${f.symptomIndex !== undefined ? ` (shows symptom [${f.symptomIndex}])` : ""}\n` +
        `  BASE (before the PR): ${clip(f.base)}\n  HEAD (with the PR):   ${clip(f.head)}`
    )
    .join("\n");

  return `Fact check against the running app. The backend ran your PR's app at BASE and at HEAD and
measured each confirmed scenario with its script. These values are observed facts from the real
program — where your text disagrees with them, the text is wrong (a PR description or a guess can be).

## Measured (per scenario, BASE and HEAD)
${measured}

## Your current text
plain.title: ${wt.plain?.title ?? ""}
plain.problem: ${wt.plain?.problem ?? ""}
plain.fix: ${wt.plain?.fix ?? ""}
summary.problem: ${wt.summary.problem}
summary.solution: ${wt.summary.solution}
symptoms:
${symptomItems}
${steps}

## Your job
Look ONLY for sentences a measured value above directly contradicts — e.g. the text says one element
is drawn on top of another and the measurement says which one is on top; the text says something
stays open and the measurement says it closed; the text states a number the measurement shows
differently. Rewrite only those sentences so they say what was measured, in the same plain style.
- Do not add new claims, numbers or details from the measurement beyond what a correction needs.
- A measurement that is silent about a claim is NOT a contradiction — leave that claim alone.
- \`narration\` never mentions measuring or checking; state the corrected fact directly.
- Keep every limit: headline ≤ 9 words, say ≤ 2 sentences, narration ≤ 4 sentences and ≤ 75 words,
  no code names in plain text.

If nothing is contradicted, reply with exactly: ${NO_CHANGES}
Otherwise return the COMPLETE walkthrough JSON object again (same rules as the analysis: no prose
around it, no markdown fence, omit hunks/coverage/pr). Only the sentences you corrected may differ.`;
}

/**
 * Copy only the prose fields of `answer` onto a copy of `wt`. Steps are matched by id; symptom texts
 * by position (their frames stay). Returns the merged walkthrough and which fields changed.
 */
export function mergeProse(wt: Walkthrough, answer: Record<string, unknown>): { walkthrough: Walkthrough; changed: string[] } {
  const out = JSON.parse(JSON.stringify(wt)) as Walkthrough;
  const changed: string[] = [];
  const take = (label: string, cur: string | undefined, next: unknown, set: (v: string) => void) => {
    if (typeof next === "string" && next.trim() && next.trim() !== (cur ?? "").trim()) {
      set(next.trim());
      changed.push(label);
    }
  };
  const plain = answer.plain as Record<string, unknown> | undefined;
  if (out.plain && plain) {
    for (const k of ["title", "problem", "fix"] as const) take(`plain.${k}`, out.plain[k], plain[k], (v) => (out.plain![k] = v));
  }
  const summary = answer.summary as Record<string, unknown> | undefined;
  if (summary) for (const k of ["problem", "solution"] as const) take(`summary.${k}`, out.summary[k], summary[k], (v) => (out.summary[k] = v));

  const byId = new Map(((answer.steps as Record<string, unknown>[]) ?? []).map((s) => [s.id as string, s]));
  for (const step of out.steps) {
    const a = byId.get(step.id);
    if (!a) continue;
    for (const k of ["title", "headline", "say", "narration"] as const) {
      take(`${step.id}.${k}`, step[k] as string | undefined, a[k], (v) => ((step as unknown as Record<string, unknown>)[k] = v));
    }
    const av = a.visual as { type?: string; items?: unknown[] } | undefined;
    if (step.visual?.type === "symptoms" && av?.type === "symptoms" && Array.isArray(av.items)) {
      step.visual.items = step.visual.items.map((item, n) => {
        const next = av.items![n];
        const nextText = typeof next === "string" ? next : (next as { text?: unknown } | undefined)?.text;
        const curText = typeof item === "string" ? item : item.text;
        if (typeof nextText !== "string" || !nextText.trim() || nextText.trim() === curText.trim()) return item;
        changed.push(`${step.id}.symptom[${n}]`);
        return typeof item === "string" ? nextText.trim() : { ...item, text: nextText.trim() };
      });
    }
  }
  return { walkthrough: out, changed };
}

export type FactCheckResult =
  | { status: "unchanged"; costUsd: number; sessionCost: number }
  | { status: "ok"; walkthrough: Walkthrough; changed: string[]; costUsd: number; sessionCost: number }
  | { status: "skipped" | "failed"; reason: string; costUsd: number; sessionCost?: number };

export async function factCheck(opts: {
  walkthrough: Walkthrough;
  facts: ScenarioFact[];
  repoPath: string;
  prLabel?: string;
  onEvent?: (e: unknown) => void;
}): Promise<FactCheckResult> {
  const wt = opts.walkthrough;
  const taskId = wt.meta.run?.taskId;
  if (!taskId) return { status: "skipped", reason: "no analysis session to resume", costUsd: 0 };
  const facts = opts.facts.filter((f) => f.base !== undefined || f.head !== undefined);
  if (facts.length === 0) return { status: "skipped", reason: "no measurements", costUsd: 0 };

  const previous = wt.meta.run?.costUsd ?? 0;
  const cap = (previous + FACTCHECK_MAX_COST).toFixed(2);
  await assertBudget(FACTCHECK_MAX_COST);
  const run = await runBob(buildFactCheckPrompt(wt, facts), opts.repoPath, cap, { resumeTaskId: taskId, onEvent: opts.onEvent });
  const costUsd = Math.max(0, run.sessionCost - previous);
  const answer = findWalkthroughInEvents(run.events);
  const base = {
    pr: opts.prLabel ?? `${wt.pr.repo}#${wt.pr.number}`,
    mode: "fact-check",
    maxCost: FACTCHECK_MAX_COST,
    actualCost: costUsd,
    durationSec: Math.round(run.ms / 1000),
    toolCalls: run.toolCalls,
    subagents: run.subagents,
    repairs: 0,
  };
  if (!answer) {
    const said = run.stdout.includes(NO_CHANGES);
    await recordSpend({ ...base, valid: true, notes: said ? "no contradictions" : run.errorMessage ?? "no JSON and no NO_CHANGES" });
    return said || !run.errorMessage
      ? { status: "unchanged", costUsd, sessionCost: run.sessionCost }
      : { status: "failed", reason: run.errorMessage, costUsd, sessionCost: run.sessionCost };
  }
  const { walkthrough, changed } = mergeProse(wt, answer);
  const schema = validateSchema(walkthrough);
  if (!schema.valid) {
    await recordSpend({ ...base, valid: false, notes: schema.errors.slice(0, 3).join("; ") });
    return { status: "failed", reason: schema.errors.slice(0, 3).join("; "), costUsd, sessionCost: run.sessionCost };
  }
  await recordSpend({ ...base, valid: true, notes: changed.length ? `corrected ${changed.join(", ")}` : "answer identical" });
  if (changed.length === 0) return { status: "unchanged", costUsd, sessionCost: run.sessionCost };
  return { status: "ok", walkthrough, changed, costUsd, sessionCost: run.sessionCost };
}
