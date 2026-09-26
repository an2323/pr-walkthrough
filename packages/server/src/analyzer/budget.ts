/**
 * budget.ts — hard spending cap for the "quality iteration" testing stage
 * (see pr-walkthrough-plan.md). Every paid Bob Shell call — from the spike
 * script or from the live `BobShellAnalyzer` — goes through this module, so
 * the cap and the human-readable log can never drift apart, and the same
 * numbers back a `GET /api/budget` endpoint for the UI.
 *
 * Deliberately a NEW, separate log from `docs/cost-log.md`: that file covers
 * the earlier ST5a spike (already spent, already accounted for); this stage
 * starts a fresh $20 allocation for the three demo-PR quality runs.
 */

import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const COST_LOG_PATH = path.join(ROOT, "docs/cost-log-stage2.md");
export const BOB_BUDGET_USD = Number(process.env.BOB_BUDGET_USD ?? 20);

const HEADER = [
  "# Bob Shell cost log — Stage 2: quality iteration",
  "",
  `Hard cap for this stage: **$${BOB_BUDGET_USD}**, tracked separately from the ST5a`,
  "spike in `docs/cost-log.md`. Every row's \"Actual cost\" is summed and checked",
  "*before* each run starts (against the run's own `--max-cost`, the worst case) —",
  "a run that could push the total over the cap is refused rather than attempted.",
  "Raw output for each run is in `data/runs/<stamp>/` (gitignored).",
  "",
  "| Date (UTC) | PR | Mode | Max cost | Actual cost | Duration | Tool calls | Subagents | Repairs | Valid | Notes |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
].join("\n");

export interface SpendRow {
  pr: string;
  mode: string;
  maxCost: number;
  actualCost: number;
  durationSec: number;
  toolCalls: number;
  subagents: number;
  repairs: number;
  valid?: boolean;
  notes?: string;
}

async function ensureFile(): Promise<void> {
  if (!existsSync(COST_LOG_PATH)) await appendFile(COST_LOG_PATH, HEADER + "\n");
}

/** Sum of every row's "Actual cost" column logged so far this stage. */
export async function spentSoFar(): Promise<number> {
  if (!existsSync(COST_LOG_PATH)) return 0;
  const text = await readFile(COST_LOG_PATH, "utf-8");
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("|") || line.startsWith("|---") || line.includes("Date (UTC)")) continue;
    const cols = line.split("|").map((c) => c.trim());
    const actual = Number(cols[5]); // | Date | PR | Mode | Max cost | Actual cost | ...
    if (!Number.isNaN(actual)) total += actual;
  }
  return total;
}

/**
 * Throws BEFORE a run starts if `plannedMaxCost` (the run's own `--max-cost`,
 * i.e. its worst case) on top of what's already been spent would exceed the
 * stage cap. Returns the current spend so callers can log context.
 */
export async function assertBudget(plannedMaxCost: number): Promise<number> {
  const spent = await spentSoFar();
  if (spent + plannedMaxCost > BOB_BUDGET_USD) {
    throw new Error(
      `Budget guard: $${spent.toFixed(2)} already spent this stage + this run's max-cost ` +
        `$${plannedMaxCost} would exceed the $${BOB_BUDGET_USD} cap. Lower --max-cost, or stop here.`
    );
  }
  return spent;
}

/** Appends one row using the run's ACTUAL cost (not its max-cost cap). */
export async function recordSpend(row: SpendRow): Promise<void> {
  await ensureFile();
  const date = new Date().toISOString().replace("T", " ").slice(0, 16);
  const cells = [
    date, row.pr, row.mode, String(row.maxCost), row.actualCost.toFixed(3),
    `${row.durationSec}s`, String(row.toolCalls), String(row.subagents), String(row.repairs),
    row.valid === undefined ? "—" : row.valid ? "yes" : "no",
    row.notes ?? "",
  ];
  await appendFile(COST_LOG_PATH, `| ${cells.join(" | ")} |\n`);
}
