/**
 * symptom-shots.ts — per-symptom BASE screenshots for a walkthrough's
 * `visual: { type: "symptoms" }` step. The Bob verifier may write a
 * `symptoms.json` manifest + optional `symptom-N.cjs` scripts; the backend
 * runs those scripts against BASE, then attaches `src` onto the matching
 * symptom items. Main before/after repro.cjs is unchanged (ablation).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ShotHighlight, SymptomItem, Walkthrough } from "@pr-walkthrough/shared";

import { annotateShot } from "../shots/annotate.js";
import { scrubbedEnv } from "./app-servers.js";
import { comparePngs } from "../shots/png-diff.js";
import { cleanHighlight, maybeCropRegion } from "./highlights.js";

const execFileAsync = promisify(execFile);

export type SymptomManifestEntry =
  | { index: number; skip: string }
  | { index: number; file: string; src?: string };

export interface SymptomsManifest {
  items: SymptomManifestEntry[];
}

/** First non-minor step with a symptoms visual, if any. */
export function findSymptomsStep(wt: Walkthrough): Walkthrough["steps"][number] | undefined {
  return wt.steps.find((s) => !s.minor && s.visual?.type === "symptoms");
}

export function symptomItemText(item: SymptomItem): string {
  return typeof item === "string" ? item : item.text;
}

/** Plain texts of the symptoms step items (for the verifier prompt). */
export function listSymptomTexts(wt: Walkthrough): string[] {
  const step = findSymptomsStep(wt);
  if (!step || step.visual?.type !== "symptoms") return [];
  return step.visual.items.map(symptomItemText);
}

export function parseSymptomsManifest(raw: unknown): SymptomsManifest | null {
  // Accept `{ items: [...] }` (documented) or a bare `[...]` (Bob often writes that).
  const itemsRaw = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (raw as { items?: unknown }).items
      : undefined;
  if (!Array.isArray(itemsRaw)) return null;
  const items: SymptomManifestEntry[] = [];
  for (const entry of itemsRaw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const index = Number(o.index);
    if (!Number.isInteger(index) || index < 0) continue;
    if (typeof o.skip === "string" && o.skip.trim()) {
      items.push({ index, skip: o.skip.trim() });
      continue;
    }
    if (typeof o.file === "string" && o.file.trim()) {
      const file = o.file.trim().replace(/^.*[/\\]/, ""); // basename only
      if (!file.endsWith(".cjs")) continue;
      items.push({
        index,
        file,
        ...(typeof o.src === "string" && o.src.trim() ? { src: o.src.trim().replace(/^.*[/\\]/, "") } : {}),
      });
    }
  }
  return items.length > 0 ? { items } : null;
}

/**
 * Attach screenshot paths onto symptom items by index. Mutates `wt` in place
 * and returns it. The map is the complete set: indices missing from it lose any old `src`;
 * strings become `{ text, src }`.
 */
export function attachSymptomShots(
  wt: Walkthrough,
  srcByIndex: ReadonlyMap<number, string> | Record<number, string>
): Walkthrough {
  const step = findSymptomsStep(wt);
  if (!step || step.visual?.type !== "symptoms") return wt;

  const lookup =
    srcByIndex instanceof Map
      ? srcByIndex
      : new Map(Object.entries(srcByIndex).map(([k, v]) => [Number(k), v]));

  step.visual = {
    type: "symptoms",
    // The map is the whole current set: a frame a newer render no longer makes is dropped, not kept
    // from an older run (#21's re-render stopped making its duplicate card, the old one stayed).
    items: step.visual.items.map((item, i) => {
      const src = lookup.get(i);
      const text = symptomItemText(item);
      if (!src) {
        if (typeof item === "string" || !item.src) return item;
        const { src: _stale, ...rest } = item;
        return rest;
      }
      if (typeof item === "string") return { text, src };
      return { ...item, src };
    }),
  };
  return wt;
}

export type SymptomCaptureResult =
  | { ok: true; highlights: ShotHighlight[] }
  | { error: string };

/**
 * Run `symptom-N.cjs <url> [pngPath]` and parse its last stdout line.
 * Expects `{ "ok": true, "highlights": [...] }`.
 */
export async function runSymptomCapture(
  scriptPath: string,
  url: string,
  cwd: string,
  pngPath?: string
): Promise<SymptomCaptureResult> {
  try {
    const args = pngPath ? [scriptPath, url, pngPath] : [scriptPath, url];
    const { stdout } = await execFileAsync("node", args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: scrubbedEnv(), // Bob-written script: no DB password, no service key
    });
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    const parsed = JSON.parse(lastLine) as { ok?: unknown; highlights?: unknown };
    if (parsed.ok !== true) return { error: "symptom script did not print {ok: true}" };
    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights.map(cleanHighlight).filter((h): h is ShotHighlight => !!h).slice(0, 3)
      : [];
    return { ok: true, highlights };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

/**
 * Load symptoms.json from the verify dir (if present), run each non-skipped
 * script against BASE, annotate when highlights exist, return index → src map.
 */
export async function captureSymptomShots(opts: {
  verifyDir: string;
  baseUrl: string;
  outDir: string;
  symptomCount: number;
  /**
   * The main BASE screenshot. A symptom frame that looks the same as it adds
   * nothing on its own card, so it is dropped (checked here, not left to the model).
   */
  beforePath?: string;
}): Promise<{ srcByIndex: Map<number, string>; notes: string[] }> {
  const { verifyDir, baseUrl, outDir, symptomCount, beforePath } = opts;
  const srcByIndex = new Map<number, string>();
  const notes: string[] = [];

  const manifestPath = path.join(verifyDir, "symptoms.json");
  if (!existsSync(manifestPath)) {
    notes.push("no symptoms.json — skipped per-symptom shots");
    return { srcByIndex, notes };
  }

  let manifest: SymptomsManifest | null;
  try {
    manifest = parseSymptomsManifest(JSON.parse(await readFile(manifestPath, "utf-8")));
  } catch {
    notes.push("symptoms.json unreadable");
    return { srcByIndex, notes };
  }
  if (!manifest) {
    notes.push("symptoms.json empty or malformed");
    return { srcByIndex, notes };
  }

  for (const entry of manifest.items) {
    if (entry.index < 0 || entry.index >= symptomCount) {
      notes.push(`index ${entry.index} out of range — ignored`);
      continue;
    }
    if ("skip" in entry) {
      notes.push(`symptom ${entry.index}: skipped — ${entry.skip}`);
      continue;
    }

    const scriptPath = path.join(verifyDir, entry.file);
    if (!existsSync(scriptPath)) {
      notes.push(`symptom ${entry.index}: missing ${entry.file}`);
      continue;
    }

    const rawName = `symptom-${entry.index}.png`;
    const rawPath = path.join(outDir, rawName);
    const result = await runSymptomCapture(scriptPath, baseUrl, verifyDir, rawPath);
    if ("error" in result) {
      notes.push(`symptom ${entry.index}: ${result.error}`);
      continue;
    }
    if (!existsSync(rawPath)) {
      notes.push(`symptom ${entry.index}: script ok but no PNG written`);
      continue;
    }

    if (beforePath && existsSync(beforePath)) {
      const same = comparePngs(await readFile(rawPath), await readFile(beforePath));
      if (same?.identical) {
        notes.push(`symptom ${entry.index}: looks the same as the main before screenshot — dropped`);
        continue;
      }
    }

    let src = rawName;
    if (result.highlights.length > 0) {
      const annotatedName = `symptom-${entry.index}-annotated.png`;
      const crop = maybeCropRegion(result.highlights, []);
      await annotateShot(rawPath, path.join(outDir, annotatedName), result.highlights, "bad", crop);
      src = annotatedName;
    }
    srcByIndex.set(entry.index, src);
    notes.push(`symptom ${entry.index}: ${src}`);
  }

  return { srcByIndex, notes };
}
