/**
 * progress-normalizer.ts — turns raw `bob run --format stream-json` events
 * into the small, UI-facing `ProgressEvent` stream (see
 * @pr-walkthrough/shared). Used live by BobShellAnalyzer (fed through
 * runBob's `onEvent` hook) and offline by `scripts/make-replay.ts`, which
 * feeds it the same raw events from a recorded run to produce the committed
 * replay file — same code path, so a live run and its replay normalize
 * identically.
 *
 * Confirmed event shapes (docs/analyzer-prompt.md / pr-walkthrough-plan.md
 * "Bob Shell Analyzer Design", and a real run's events.ndjson):
 *   {"type":"message","role":"user",content}       — the full prompt, echoed back. Never forwarded.
 *   {"type":"message","role":"assistant",content}  — a text delta of Bob's answer.
 *   {"type":"tool_use","tool_name":...,"parameters":{...}}
 *   {"type":"tool_result",...}                     — no separate UI signal today.
 *   {"type":"error","message":...}
 *   {"type":"result","stats":{session_costs,max_cost,tool_calls,...}}
 */

import type { ProgressEvent } from "@pr-walkthrough/shared";

/** Collapse assistant text deltas into at most one "writing" event per second. */
const WRITING_THROTTLE_MS = 1000;

export interface ProgressNormalizer {
  /**
   * Feed one raw parsed event (or raw line — malformed lines are ignored).
   * `nowMs` anchors the emitted `t` (ms since the run started) against the
   * normalizer's `startMs` — pass `Date.now()` for a live run, or the
   * event's own recorded timestamp for offline replay generation.
   */
  handle(raw: unknown, nowMs?: number): void;
}

/** Human-readable target for a tool call, from its raw parameters. */
function toolTarget(toolName: string, params: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file":
      return `Reading ${shortenPath(String(params["path"] ?? ""))}`;
    case "list_dir":
    case "list_files":
      return `Listing ${shortenPath(String(params["path"] ?? ""))}`;
    case "grep":
    case "search_files": {
      const pattern = String(params["pattern"] ?? params["query"] ?? "");
      return pattern ? `Searching for \`${pattern}\`` : "Searching files";
    }
    case "spawn_subagent": {
      // Descriptions often embed the absolute checkout path — reduce it to "the repo".
      const desc = String(params["description"] ?? params["task"] ?? "")
        .replace(/\s*(?:at\s+)?\/\S*\/wt\/[0-9a-f]+\/?/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return `Sub-agent: ${desc.slice(0, 80)}${desc.length > 80 ? "…" : ""}`;
    }
    default:
      return toolName.replace(/_/g, " ");
  }
}

/**
 * Tool parameters carry absolute checkout paths, e.g.
 * `/tmp/pr-walkthrough-repos/excalidraw__excalidraw/wt/<sha>/packages/…` —
 * show only the repo-relative tail (past the worktree's `wt/<sha>/`
 * segment), which is what a reviewer actually recognises.
 */
function shortenPath(p: string): string {
  const marker = "/wt/";
  const i = p.indexOf(marker);
  if (i === -1) return p;
  const rest = p.slice(i + marker.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(slash + 1);
}

/** Create a stateful handler for one bob run's raw event stream. */
export function createProgressNormalizer(startMs: number, emit: (e: ProgressEvent) => void): ProgressNormalizer {
  let writingChars = 0;
  let lastWritingEmitMs = -Infinity;

  return {
    handle(raw: unknown, nowMs: number = Date.now()): void {
      if (!raw || typeof raw !== "object") return;
      const e = raw as Record<string, unknown>;
      const t = nowMs - startMs;

      if (e["type"] === "message") {
        if (e["role"] === "user") return; // full prompt echo — never forward
        if (e["role"] === "assistant" && typeof e["content"] === "string") {
          writingChars += (e["content"] as string).length;
          if (nowMs - lastWritingEmitMs >= WRITING_THROTTLE_MS) {
            lastWritingEmitMs = nowMs;
            emit({ kind: "writing", t, chars: writingChars });
          }
        }
        return;
      }

      if (e["type"] === "tool_use") {
        const toolName = String(e["tool_name"] ?? "tool");
        const params = (e["parameters"] as Record<string, unknown> | undefined) ?? {};
        emit({ kind: "tool", t, tool: toolName, target: toolTarget(toolName, params) });
        return;
      }

      if (e["type"] === "tool_result") return; // no separate UI signal today

      if (e["type"] === "error" && typeof e["message"] === "string") {
        emit({ kind: "error", t, message: e["message"] as string });
        return;
      }

      if (e["type"] === "result") {
        const stats = (e["stats"] as Record<string, unknown> | undefined) ?? {};
        const costUsd = typeof stats["session_costs"] === "number" ? (stats["session_costs"] as number) : undefined;
        if (costUsd !== undefined) {
          const maxCostUsd = typeof stats["max_cost"] === "number" ? (stats["max_cost"] as number) : undefined;
          emit({ kind: "cost", t, costUsd, maxCostUsd });
        }
      }
    },
  };
}
