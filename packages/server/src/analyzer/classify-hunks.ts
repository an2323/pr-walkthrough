/**
 * classify-hunks.ts — classify diff hunks into prompt hunks and pre-skipped hunks.
 *
 * Mechanical hunks (tests, snapshots, lockfiles, translations, generated files)
 * are excluded from the prompt hunk list and added to skippedHunks by the backend
 * so the analyzer never sees them. Coverage remains complete.
 *
 * Exported:
 *   classifyHunks(hunks) → { prompt: Hunk[]; skipped: SkippedHunk[] }
 *   groupSkippedSummary(skipped) → string[]   (for the viewer summary line)
 */

import type { Hunk } from "@pr-walkthrough/shared";

export interface SkippedHunk {
  hunkId: string;
  reason: string;
}

export interface ClassifiedHunks {
  /** Hunks the analyzer should reason about. */
  prompt: Hunk[];
  /** Hunks silently skipped by the backend with a short reason. */
  skipped: SkippedHunk[];
}

// ---------------------------------------------------------------------------
// Classification patterns
// ---------------------------------------------------------------------------

type Reason = "tests" | "snapshots" | "lockfile" | "translations" | "generated";

interface Rule {
  reason: Reason;
  /** Return true if the file path matches this rule. */
  match: (file: string) => boolean;
}

/** Normalise to forward-slashes for consistent pattern matching. */
function norm(f: string): string {
  return f.replace(/\\/g, "/");
}

const RULES: Rule[] = [
  // ── Snapshots (before tests — more specific) ──────────────────────────────
  {
    reason: "snapshots",
    match: (f) => {
      const n = norm(f);
      return n.includes("/__snapshots__/") || n.endsWith(".snap");
    },
  },

  // ── Test files ────────────────────────────────────────────────────────────
  {
    reason: "tests",
    match: (f) => {
      const n = norm(f);
      return (
        /\.(test|spec)\.[^/]+$/.test(n) ||
        /\.(e2e)\.[^/]+$/.test(n) ||
        n.includes("/__tests__/") ||
        n.includes("/tests/") ||
        n.includes("/test/") ||
        n.includes("/__mocks__/") ||
        n.includes(".e2e-") ||
        /\.stories\.[^/]+$/.test(n) ||
        // Cypress / Playwright / Vitest fixtures
        n.includes("/cypress/") ||
        n.includes("/e2e/") ||
        n.includes("/fixtures/")
      );
    },
  },

  // ── Lockfiles ─────────────────────────────────────────────────────────────
  {
    reason: "lockfile",
    match: (f) => {
      const base = norm(f).split("/").pop() ?? "";
      return (
        base === "package-lock.json" ||
        base === "yarn.lock" ||
        base === "pnpm-lock.yaml" ||
        base === "Cargo.lock" ||
        base === "Gemfile.lock" ||
        base === "composer.lock" ||
        base === "go.sum" ||
        base === "poetry.lock" ||
        base === "bun.lockb" ||
        base.endsWith(".lock")
      );
    },
  },

  // ── Translations / locales ────────────────────────────────────────────────
  {
    reason: "translations",
    match: (f) => {
      const n = norm(f);
      return (
        n.includes("/locales/") ||
        n.includes("/translations/") ||
        n.includes("/i18n/") ||
        n.includes("/lang/") ||
        n.includes("/locale/") ||
        /\.(po|pot|ftl|arb|xliff|xlf)$/.test(n)
      );
    },
  },

  // ── Generated files ───────────────────────────────────────────────────────
  {
    reason: "generated",
    match: (f) => {
      const n = norm(f);
      return (
        n.includes("/__generated__/") ||
        n.includes("/generated/") ||
        /\.(generated|gen)\.[^/]+$/.test(n) ||
        /\.pb\.(go|ts|js)$/.test(n) ||
        n.endsWith(".graphql.ts") ||
        n.endsWith(".d.ts") ||
        // Common codegen outputs
        n.includes("/graphql/types") ||
        n.includes("/api/types.ts") ||
        n.endsWith("schema.json") ||
        n.endsWith("schema.graphql")
      );
    },
  },
];

/**
 * Classify `hunks` into those that belong in the prompt and those that
 * should be pre-skipped by the backend.
 *
 * Rules are applied in order; the first match wins.
 */
export function classifyHunks(hunks: Hunk[]): ClassifiedHunks {
  const prompt: Hunk[] = [];
  const skipped: SkippedHunk[] = [];

  for (const hunk of hunks) {
    let matched = false;
    for (const rule of RULES) {
      if (rule.match(hunk.file)) {
        skipped.push({ hunkId: hunk.id, reason: rule.reason });
        matched = true;
        break;
      }
    }
    if (!matched) prompt.push(hunk);
  }

  return { prompt, skipped };
}

// ---------------------------------------------------------------------------
// Viewer summary helpers
// ---------------------------------------------------------------------------

/** Friendly label for each skip reason, for the SummaryScreen "Also in this PR" list. */
const REASON_LABEL: Record<string, string> = {
  tests: "test",
  snapshots: "snapshot",
  lockfile: "lockfile",
  translations: "translation",
  generated: "generated",
};

/**
 * Collapse pre-skipped hunks (those whose reason is one of the mechanical
 * reasons above) into one summary line per group.
 *
 * Returns strings like "272 test and snapshot hunks" or "5 lockfile hunks".
 * Non-mechanical skipped hunks (authored by the analyzer) are not touched.
 */
export function groupSkippedSummary(skipped: { hunkId: string; reason: string }[]): string[] {
  const counts: Record<string, number> = {};
  for (const s of skipped) {
    if (REASON_LABEL[s.reason]) {
      counts[s.reason] = (counts[s.reason] ?? 0) + 1;
    }
  }

  // Group "tests" and "snapshots" together (they look the same to a reviewer).
  const combined: { label: string; count: number }[] = [];
  const testCount = (counts["tests"] ?? 0) + (counts["snapshots"] ?? 0);
  if (testCount > 0) combined.push({ label: "test and snapshot", count: testCount });
  for (const reason of ["lockfile", "translations", "generated"] as const) {
    if (counts[reason]) combined.push({ label: REASON_LABEL[reason], count: counts[reason] });
  }

  return combined.map(
    ({ label, count }) => `${count} ${label} hunk${count !== 1 ? "s" : ""}`
  );
}
