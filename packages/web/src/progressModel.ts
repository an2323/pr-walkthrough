/**
 * progressModel.ts — turns the stream of ProgressEvents into what the analysis screen shows.
 *
 * Pure (no React, no clock): the same function renders a live run, a page reload that replays the whole
 * backlog, and a recording of a run made before the newer events existed. Every new event kind is optional;
 * without `plan` / `files` / `outcome` the screen degrades to the stage list it always had.
 */

import type { ProgressEvent, ProgressEventOf, ShotsOutcomeCode } from '@pr-walkthrough/shared';

export type StepStatus = 'done' | 'current' | 'pending' | 'skipped' | 'warn';

export interface StepView {
  id: 'checkout' | 'diff' | 'read' | 'check' | 'shots' | 'voice';
  label: string;
  status: StepStatus;
  /** One short line under the label. */
  detail?: string;
}

export type FileStatus = 'todo' | 'reading' | 'read' | 'hidden';

export interface FileView {
  path: string;
  additions: number;
  deletions: number;
  status: FileStatus;
}

/** Which card the right-hand pane shows. */
export type PaneView = 'files' | 'reproducing' | 'outcome';

export interface ProgressView {
  pr?: ProgressEventOf<'plan'>['pr'];
  steps: StepView[];
  files: FileView[];
  scenario: string[];
  feed: string[];
  pane: PaneView;
  shots: {
    /** Known from the start when the server sent a plan. */
    planned: boolean | undefined;
    reason?: string;
    outcome?: { code: ShotsOutcomeCode; message: string };
    frames?: { before: string; after: string; caption?: string };
  };
  costUsd?: number;
  maxCostUsd?: number;
  subagents: number;
  /** Elapsed at the latest event, in ms (the server's clock). */
  elapsedMs: number;
  done?: ProgressEventOf<'done'>;
  error?: string;
}

const FEED_SIZE = 6;

function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

function of<K extends ProgressEvent['kind']>(events: ProgressEvent[], kind: K): ProgressEventOf<K>[] {
  return events.filter((e): e is ProgressEventOf<K> => e.kind === kind);
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** "Reading packages/x/y.ts" → "packages/x/y.ts"; other targets are returned as they are. */
function targetPath(target: string): string {
  return target.replace(/^Reading\s+/, '').replace(/^\.walkthrough\/base\//, '');
}

const OUTCOME_STATUS: Record<ShotsOutcomeCode, StepStatus> = {
  ok: 'done',
  identical: 'done',
  'no-recipe': 'skipped',
  'non-visual': 'skipped',
  'app-failed': 'warn',
  'not-reproduced': 'warn',
  unavailable: 'warn',
};

export function deriveProgressView(events: ProgressEvent[]): ProgressView {
  const stages = of(events, 'stage');
  const seen = new Set(stages.map((s) => s.stage));
  const plan = last(of(events, 'plan'));
  const filesEvent = last(of(events, 'files'));
  const scenarioEvent = last(of(events, 'scenario'));
  const outcome = last(of(events, 'outcome'));
  const framesEvent = last(of(events, 'frames'));
  const done = last(of(events, 'done'));
  const error = last(of(events, 'error'));
  const tools = of(events, 'tool');
  const cost = last(of(events, 'cost'));
  const writing = last(of(events, 'writing'));
  const lastStage = last(stages);
  const labelOf = (stage: string): string | undefined => last(stages.filter((s) => s.stage === stage))?.label;

  const inShots = seen.has('app') || seen.has('shots');
  const planned = plan ? plan.shots.planned : undefined;

  // Order the pipeline runs in. `repairing` belongs to whatever is being repaired (the story before the
  // screenshots, the text after them) and must never move the screen backwards.
  const order: StepView['id'][] = ['checkout', 'diff', 'read', 'check', 'shots', 'voice'];
  const stageStep = (stage: string): StepView['id'] | undefined => {
    switch (stage) {
      case 'clone': return 'checkout';
      case 'hunks': return 'diff';
      case 'analyzing': return 'read';
      case 'validating':
      case 'saving': return 'check';
      case 'repairing': return inShots ? 'shots' : 'check';
      case 'app':
      case 'shots': return 'shots';
      case 'voicing': return 'voice';
      default: return undefined;
    }
  };
  let currentIdx = -1;
  for (const s of stages) {
    const step = stageStep(s.stage);
    if (step) currentIdx = Math.max(currentIdx, order.indexOf(step));
  }

  // --- the screenshot row decides for itself -------------------------------------------------
  let shotsStatus: StepStatus | undefined;
  let shotsDetail: string | undefined;
  if (outcome) {
    shotsStatus = OUTCOME_STATUS[outcome.code];
    shotsDetail = outcome.message;
    // Work that still belongs to the screenshot stage after the verdict (measuring, revising, checking the text).
    const busy = !done && lastStage && (lastStage.stage === 'shots' || lastStage.stage === 'repairing');
    if (busy && outcome.code === 'ok') shotsDetail = lastStage.label;
  } else if (planned === false) {
    shotsStatus = 'skipped';
    shotsDetail = plan?.shots.reason;
  } else if (inShots) {
    shotsStatus = done ? 'done' : 'current';
    shotsDetail = labelOf('shots') ?? labelOf('app');
  } else if (planned === true) {
    shotsStatus = 'pending';
    shotsDetail = 'planned — this app can be started';
  }

  const base: StepView[] = [
    { id: 'checkout', label: 'Checked out the PR', status: 'pending' },
    { id: 'diff', label: 'Split the diff', status: 'pending' },
    { id: 'read', label: 'Reading the code', status: 'pending' },
    { id: 'check', label: 'Checking the story', status: 'pending' },
    { id: 'shots', label: 'Screenshots', status: shotsStatus ?? 'pending' },
    { id: 'voice', label: 'Recording the voice-over', status: 'pending' },
  ];
  const detail: Partial<Record<StepView['id'], string | undefined>> = {
    checkout: labelOf('clone'),
    diff: labelOf('hunks'),
    read: writing ? `Writing the walkthrough… ${writing.chars.toLocaleString()} chars` : undefined,
    check: !inShots ? labelOf('repairing') ?? labelOf('validating') : undefined,
    voice: labelOf('voicing'),
  };
  const steps: StepView[] = [];
  for (const st of base) {
    // Old recordings have no screenshot row unless a screenshot stage ran; the voice row exists only when voicing ran.
    if (st.id === 'shots' && shotsStatus === undefined) continue;
    if (st.id === 'voice' && !seen.has('voicing')) continue;
    const idx = order.indexOf(st.id);
    const row = { ...st };
    if (st.id === 'shots') {
      if (shotsDetail) row.detail = shotsDetail;
    } else if (done || idx < currentIdx) {
      row.status = 'done';
      if (st.id === 'diff' && detail.diff) row.detail = detail.diff;
    } else if (idx === currentIdx) {
      row.status = 'current';
      if (detail[st.id]) row.detail = detail[st.id];
    }
    steps.push(row);
  }

  // --- files ---------------------------------------------------------------------------------
  const reads = tools.map((t) => targetPath(t.target));
  const latest = last(reads);
  const files: FileView[] = (filesEvent?.files ?? []).map((f) => {
    const mentioned = (t: string) => t.includes(f.path) || t.endsWith(basename(f.path));
    let status: FileStatus = 'todo';
    if (f.skipped) status = 'hidden';
    else if (!done && latest !== undefined && mentioned(latest)) status = 'reading';
    else if (reads.some(mentioned)) status = 'read';
    return { path: f.path, additions: f.additions, deletions: f.deletions, status };
  });

  // --- feed and pane -------------------------------------------------------------------------
  const feed = inShots
    ? stages.filter((s) => s.stage === 'app' || s.stage === 'shots').map((s) => s.label).slice(-FEED_SIZE)
    : tools.map((t) => t.target).slice(-FEED_SIZE);
  const pane: PaneView = outcome ? 'outcome' : inShots && !done ? 'reproducing' : 'files';

  return {
    ...(plan ? { pr: plan.pr } : {}),
    steps,
    files,
    scenario: scenarioEvent?.lines ?? [],
    feed,
    pane,
    shots: {
      planned,
      ...(plan?.shots.reason ? { reason: plan.shots.reason } : {}),
      ...(outcome ? { outcome: { code: outcome.code, message: outcome.message } } : {}),
      ...(framesEvent
        ? { frames: { before: framesEvent.before, after: framesEvent.after, ...(framesEvent.caption ? { caption: framesEvent.caption } : {}) } }
        : {}),
    },
    ...(cost ? { costUsd: cost.costUsd, ...(cost.maxCostUsd !== undefined ? { maxCostUsd: cost.maxCostUsd } : {}) } : {}),
    subagents: tools.filter((t) => t.tool === 'spawn_subagent').length,
    elapsedMs: events.reduce((m, e) => Math.max(m, e.t), 0),
    ...(done ? { done } : {}),
    ...(error ? { error: error.message } : {}),
  };
}
