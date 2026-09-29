/**
 * scenarios.ts — one repro script per user-visible problem.
 *
 * A PR often fixes more than one thing the user sees (e.g. a panel drawn under the toolbar AND a
 * menu that opens behind that panel on phones). One script can only prove one of them, and an
 * ablation measured with one script calls every hunk of the OTHER mechanism "no effect" — which
 * is false and, fed into revise, rewrites correct prose into wrong prose. So the verifier writes a
 * script per problem (`scenarios.json`), each held to the same contract (true on BASE, false on
 * HEAD), each giving its own before/after frames, and ablation runs all of them on every build.
 *
 * `scenarios.json` (written by Bob under .walkthrough/verify/):
 *   [{ "id": "menu", "file": "repro-menu.cjs", "title": "Opening the menu leaves the panel open",
 *      "symptomIndex": 1 }]
 * A folder with only the old single `repro.cjs` is one scenario.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Scenario {
  /** Short stable id ([a-z0-9-]), used in file names and the ablation table. */
  id: string;
  /** Script file name inside the verify dir (basename only). */
  file: string;
  /** Plain words: the behaviour it checks — shown to revise and to readers of the evidence. */
  title: string;
  /** Which item of the walkthrough's symptoms list this scenario shows, if any. */
  symptomIndex?: number;
}

export const MAX_SCENARIOS = 3;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "s";
}

/** Parse a manifest (object with `scenarios`, or a bare array). Invalid entries are dropped, ids made unique. */
export function parseScenarios(raw: unknown): Scenario[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as { scenarios?: unknown }).scenarios : undefined;
  if (!Array.isArray(list)) return [];
  const out: Scenario[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.file !== "string") continue;
    const file = o.file.trim().replace(/^.*[/\\]/, "");
    if (!file.endsWith(".cjs")) continue;
    const title = typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 140) : file;
    let id = slug(typeof o.id === "string" && o.id.trim() ? o.id : file.replace(/\.cjs$/, ""));
    for (let n = 2; seen.has(id); n++) id = `${slug(id)}-${n}`;
    seen.add(id);
    const idx = Number(o.symptomIndex);
    out.push({ id, file, title, ...(Number.isInteger(idx) && idx >= 0 ? { symptomIndex: idx } : {}) });
    if (out.length === MAX_SCENARIOS) break;
  }
  return out;
}

/**
 * The scenarios in a verify dir: `scenarios.json` when present and valid (entries whose script is
 * missing are kept — confirmation reports them as missing, and the repair can write them),
 * otherwise the legacy single `repro.cjs`, otherwise none.
 */
export async function loadScenarios(verifyDir: string, fallbackTitle = "The fixed behaviour"): Promise<Scenario[]> {
  const manifest = path.join(verifyDir, "scenarios.json");
  if (existsSync(manifest)) {
    try {
      const parsed = parseScenarios(JSON.parse(await readFile(manifest, "utf-8")));
      if (parsed.length > 0) return parsed;
    } catch {
      /* unreadable manifest — fall back */
    }
  }
  if (existsSync(path.join(verifyDir, "repro.cjs"))) return [{ id: "main", file: "repro.cjs", title: fallbackTitle }];
  return inferScenarios(verifyDir);
}

/**
 * Bob wrote scripts but stopped before scenarios.json (out of budget, out of turns, credit ran out).
 * The scripts are still evidence and the backend holds them to the same contract, so use them: every
 * script that isn't a helper or a probe is a scenario, titled from its opening comment.
 */
export async function inferScenarios(verifyDir: string): Promise<Scenario[]> {
  let files: string[] = [];
  try {
    files = (await readdir(verifyDir)).filter((f) => f.endsWith(".cjs") && f !== "pw.cjs" && !/^probe/i.test(f)).sort();
  } catch {
    return [];
  }
  const out: Scenario[] = [];
  for (const file of files.slice(0, MAX_SCENARIOS)) {
    const head = (await readFile(path.join(verifyDir, file), "utf-8").catch(() => "")).slice(0, 600);
    // Opening comment → first meaningful line, without the comment decoration and a "Scenario 0:" prefix.
    const lines = head
      .split("\n")
      .map((l) => l.replace(/^\s*(?:\/\*+|\*\/|\*|\/\/)+\s?/, "").replace(/\*\/\s*$/, "").trim())
      .filter(Boolean);
    const first = lines.find((l) => l.length >= 8 && !/^(usage|@|use strict|const |let |var |"use)/i.test(l) && l.length <= 200);
    const isCode = /^(const|let|var|async|await|\(|\{|process\.|console\.|require)/.test(first ?? "");
    const title = (first && !isCode ? (/^scenario\s*\d*\s*[:\-–]\s*(.+)$/i.exec(first)?.[1] ?? first) : file.replace(/\.cjs$/, "").replace(/[-_]+/g, " ")).trim().replace(/[.]+$/, "");
    const idx = /symptom[-_ ]?(\d+)|scenario[-_ ]?(\d+)/i.exec(file + " " + head);
    const symptomIndex = idx ? Number(idx[1] ?? idx[2]) : undefined;
    out.push({ id: slug(file.replace(/\.cjs$/, "")), file, title, ...(symptomIndex !== undefined && symptomIndex >= 0 ? { symptomIndex } : {}) });
  }
  return out;
}
