/**
 * unchanged-symptoms.ts — a listed symptom the PR does not change is not a symptom of this PR.
 *
 * On #10199 the analysis listed "the menu is hidden behind the properties popup" as a problem the PR
 * fixes; the PR keeps the popup above the menu on purpose (40 > 10 before, 100 > 90 after) and its own
 * fix text says so. No before/after pair can exist, and the verifier paid $3.58 looking for one.
 * The verifier now says so in `.walkthrough/verify/unchanged.json`; the backend removes that item from
 * the symptoms list and the fact check rewrites the sentences that still present it as fixed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { Walkthrough } from "@pr-walkthrough/shared";

import { findSymptomsStep, symptomItemText } from "./symptom-shots.js";

export const UNCHANGED_FILE = "unchanged.json";

export interface UnchangedSymptom {
  symptomIndex: number;
  why: string;
}

/** `[{symptomIndex, why}]` (or `{items: [...]}`) from the verifier's directory; anything malformed is ignored. */
export function readUnchanged(verifyDir: string): UnchangedSymptom[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(verifyDir, UNCHANGED_FILE), "utf-8"));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return [];
  const out: UnchangedSymptom[] = [];
  for (const e of list) {
    const o = (e ?? {}) as Record<string, unknown>;
    const i = Number(o.symptomIndex ?? o.index);
    if (Number.isInteger(i) && i >= 0 && typeof o.why === "string" && o.why.trim() && !out.some((x) => x.symptomIndex === i)) {
      out.push({ symptomIndex: i, why: o.why.trim() });
    }
  }
  return out;
}

export interface DroppedSymptom {
  index: number;
  /** How many items the list had when this was planned (indices are only valid at that length). */
  of: number;
  text: string;
  why: string;
}

/**
 * Which listed symptoms to remove: never one with a picture (a confirmed scenario proved it changes) and
 * never the last one left. Nothing is changed yet — the fact check sees them first, so the prose around
 * them can be rewritten; `removeSymptoms` takes them out afterwards (the item count, and so every index,
 * stays the same until then).
 */
export function symptomsToDrop(wt: Walkthrough, unchanged: UnchangedSymptom[]): DroppedSymptom[] {
  const step = findSymptomsStep(wt);
  if (!step || step.visual?.type !== "symptoms" || unchanged.length === 0) return [];
  const items = step.visual.items;
  const out: DroppedSymptom[] = [];
  for (const u of unchanged) {
    const item = items[u.symptomIndex];
    if (item === undefined || (typeof item !== "string" && item.src)) continue;
    out.push({ index: u.symptomIndex, of: items.length, text: symptomItemText(item), why: u.why });
  }
  return out.length >= items.length ? [] : out;
}

/** Remove the planned items, in place. */
export function removeSymptoms(wt: Walkthrough, drop: DroppedSymptom[]): void {
  const step = findSymptomsStep(wt);
  if (!step || step.visual?.type !== "symptoms" || drop.length === 0) return;
  if (drop.some((d) => d.of !== (step.visual?.type === "symptoms" ? step.visual.items.length : -1))) {
    console.warn("[verify] symptoms list changed since the unchanged ones were planned; nothing removed");
    return;
  }
  const gone = new Set(drop.map((d) => d.index));
  step.visual.items = step.visual.items.filter((_, i) => !gone.has(i));
  console.log(`[verify] symptoms the PR does not change, removed: ${drop.map((d) => `"${d.text}" (${d.why})`).join("; ")}`);
}
