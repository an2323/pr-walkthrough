/**
 * ProgressScreen — live (or replayed) view of a Bob Shell analysis run (ST6c).
 *
 * Route: /:owner/:repo/:number/progress?job=<id>   — live, from POST /api/analyze
 *        /:owner/:repo/:number/progress?replay=1   — replay of a recorded run ($0 demo)
 *
 * Reads a ProgressEvent stream over SSE (EventSource): stage transitions,
 * the current tool action, a throttled "writing the walkthrough…" signal,
 * running cost, and a final "done"/"error". A page reload reconnects to the
 * same EventSource URL and gets the full backlog again (see
 * GET /api/jobs/:jobId/events and GET /api/runs/.../events on the server).
 */

import { useEffect, useRef, useState } from 'react';
import type { ProgressEvent, ProgressEventOf, ProgressStage } from '@pr-walkthrough/shared';
import './ProgressScreen.css';

const STAGES: { stage: ProgressStage; label: string }[] = [
  { stage: 'clone', label: 'Workspace' },
  { stage: 'hunks', label: 'Diff' },
  { stage: 'analyzing', label: 'Analyzing' },
  { stage: 'validating', label: 'Validating' },
  { stage: 'repairing', label: 'Repairing' },
  { stage: 'saving', label: 'Saving' },
];

/** How long to show the "Done" state before auto-navigating to the viewer. */
const AUTO_NAVIGATE_MS = 1500;
/** Only the most recent tool actions are kept on screen. */
const TOOL_LOG_SIZE = 8;

interface Props {
  owner: string;
  repo: string;
  number: number;
}

function fmtElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function isKind<K extends ProgressEvent['kind']>(kind: K) {
  return (e: ProgressEvent): e is ProgressEventOf<K> => e.kind === kind;
}

/** Last element of an array, or undefined — `Array.prototype.at` needs a newer lib target than this package uses. */
function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

export function ProgressScreen({ owner, repo, number }: Props) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [connectionLost, setConnectionLost] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startRef = useRef(Date.now());
  const gotAnyEventRef = useRef(false);

  const search = new URLSearchParams(window.location.search);
  const jobId = search.get('job');
  const isReplay = search.get('replay') != null;
  const speed = search.get('speed'); // optional override, forwarded to the replay endpoint as-is
  const viewerPath = `/${owner}/${repo}/${number}`;

  // ---- SSE subscription ----
  useEffect(() => {
    const url = isReplay
      ? `/api/runs/${owner}/${repo}/${number}/events${speed ? `?speed=${encodeURIComponent(speed)}` : ''}`
      : jobId
      ? `/api/jobs/${jobId}/events`
      : null;
    if (!url) {
      setConnectionLost(true);
      return;
    }

    const es = new EventSource(url);
    es.onmessage = (msg: MessageEvent<string>) => {
      gotAnyEventRef.current = true;
      let e: ProgressEvent;
      try {
        e = JSON.parse(msg.data) as ProgressEvent;
      } catch {
        return; // malformed line — ignore rather than crash the screen
      }
      setEvents((prev) => [...prev, e]);
      if (e.kind === 'done' || e.kind === 'error') es.close();
    };
    es.onerror = () => {
      // EventSource retries connections on its own; only treat this as fatal
      // if we never received anything at all (a dead job id, server down…).
      if (!gotAnyEventRef.current) setConnectionLost(true);
    };
    return () => es.close();
  }, [owner, repo, number, jobId, isReplay, speed]);

  // ---- Elapsed clock ----
  useEffect(() => {
    const id = setInterval(() => setElapsedMs(Date.now() - startRef.current), 500);
    return () => clearInterval(id);
  }, []);

  const doneEvent = last(events.filter(isKind('done')));
  const errorEvent = last(events.filter(isKind('error')));
  const lastStage = last(events.filter(isKind('stage')));
  const lastTool = last(events.filter(isKind('tool')));
  const lastWriting = last(events.filter(isKind('writing')));
  const lastCost = last(events.filter(isKind('cost')));
  const toolLog = events.filter(isKind('tool')).slice(-TOOL_LOG_SIZE);
  const subagentCount = events.filter(isKind('tool')).filter((e) => e.tool === 'spawn_subagent').length;

  // ---- Auto-navigate to the viewer once done ----
  useEffect(() => {
    if (!doneEvent) return;
    const id = setTimeout(() => {
      window.location.href = viewerPath;
    }, AUTO_NAVIGATE_MS);
    return () => clearTimeout(id);
  }, [doneEvent, viewerPath]);

  if (errorEvent) {
    return (
      <div className="progress-screen">
        <div className="progress-card progress-error">
          <p className="progress-error-message">Analysis failed: {errorEvent.message}</p>
          <a className="v2btn" href="/">← Back</a>
        </div>
      </div>
    );
  }

  const seenStages = new Set(events.filter(isKind('stage')).map((e) => e.stage));
  const currentStageIdx = lastStage ? STAGES.findIndex((s) => s.stage === lastStage.stage) : -1;
  const visibleStages = STAGES.filter((s) => s.stage !== 'repairing' || seenStages.has('repairing'));

  return (
    <div className="progress-screen">
      <div className="progress-card">
        <div className="progress-header">
          <div className="progress-pr">
            {owner}/{repo} <span className="progress-pr-number">#{number}</span>
          </div>
          <div className="progress-elapsed">{fmtElapsed(elapsedMs)}</div>
        </div>

        {connectionLost && (
          <p className="progress-connection-error">Lost connection to the server — retrying…</p>
        )}

        <ol className="progress-stages">
          {visibleStages.map((s) => {
            const idx = STAGES.findIndex((x) => x.stage === s.stage);
            const status = doneEvent || idx < currentStageIdx ? 'done' : idx === currentStageIdx ? 'current' : 'pending';
            return (
              <li key={s.stage} className={`progress-stage progress-stage--${status}`}>
                {s.label}
              </li>
            );
          })}
        </ol>

        {!doneEvent && (
          <p className="progress-current-action">
            {lastWriting
              ? `Writing the walkthrough… ${lastWriting.chars.toLocaleString()} chars`
              : lastTool?.target ?? 'Starting…'}
          </p>
        )}

        {toolLog.length > 0 && !doneEvent && (
          <div className="progress-log" aria-label="Recent Bob actions">
            {toolLog.map((e, i) => (
              <div key={i} className="progress-log-line">{e.target}</div>
            ))}
          </div>
        )}

        <div className="progress-meta">
          {subagentCount > 0 && (
            <span className="progress-meta-item">{subagentCount} sub-agent{subagentCount !== 1 ? 's' : ''}</span>
          )}
          {lastCost && (
            <span className="progress-meta-item">
              ${lastCost.costUsd.toFixed(2)}
              {lastCost.maxCostUsd !== undefined ? ` / max $${lastCost.maxCostUsd}` : ''}
            </span>
          )}
        </div>

        {doneEvent && (
          <div className="progress-done">
            <p className="progress-done-summary">
              Done
              {doneEvent.costUsd !== undefined && ` · $${doneEvent.costUsd.toFixed(2)}`}
              {' · '}
              {fmtElapsed(doneEvent.durationMs)}
              {doneEvent.toolCalls !== undefined && ` · ${doneEvent.toolCalls} tool calls`}
              {doneEvent.subagents !== undefined && ` · ${doneEvent.subagents} sub-agent${doneEvent.subagents !== 1 ? 's' : ''}`}
            </p>
            <a className="v2btn primary" href={viewerPath}>Open the walkthrough →</a>
          </div>
        )}
      </div>
    </div>
  );
}
