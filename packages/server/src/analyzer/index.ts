/**
 * analyzer/index.ts — factory that selects the analyzer implementation
 * based on the ANALYZER environment variable (default: "cached").
 */

import type { Analyzer } from "./interface.js";
import { CachedAnalyzer } from "./cached.js";
import { BobShellAnalyzer } from "./bob-shell.js";

export function createAnalyzer(): Analyzer {
  const type = process.env.ANALYZER ?? "cached";
  if (type === "bob") return new BobShellAnalyzer();
  if (type === "cached") return new CachedAnalyzer();
  throw new Error(`Unknown ANALYZER: ${type}`);
}

export type { Analyzer } from "./interface.js";
export type { AnalyzerInput, WalkthroughDraft } from "./interface.js";
export { CachedAnalyzer } from "./cached.js";
export { BobShellAnalyzer } from "./bob-shell.js";
