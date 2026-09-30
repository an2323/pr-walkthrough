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
  id: 'checkout' | 'diff' | 'read' | 'check' | 'shots' | 'facts' | 'voice';
  label: string;
  status: StepStatus;
  /** One short line under the label. */
  detail?: string;
  /** A bar under the detail: known progress (`done` of `total`), or only "alive" (`indeterminate`). */
  progress?: { done: number; total: number } | { indeterminate: true };
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
  /** How long this run should take, from the plan event (absent on older runs). */
  estimate?: NonNullable<ProgressEventOf<'plan'>['estimate']>;
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

/** The analysis text is one long answer: say it is being written, and about how far along it is. */
function writingDetail(chars: number): string {
  return chars < TYPICAL_WRITING_CHARS
    ? `Bob is writing the walkthrough — about ${chars.toLocaleString('en-US')} of ~${TYPICAL_WRITING_CHARS.toLocaleString('en-US')} characters`
    : `Bob is still writing — ${chars.toLocaleString('en-US')} characters so far`;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** "Reading packages/x/y.ts" → "packages/x/y.ts"; other targets are returned as they are. */
function targetPath(target: string): string {
  return target.replace(/^Reading\s+/, '').replace(/^\.walkthrough\/base\//, '');
}

/**
 * A stage label written for the log, said for a reader. The ablation runs one label per hunk ("Testing "packages/…/x.tsx#1"
 * alone") — file paths and hunk ids mean nothing on the screen, and an unbroken path used to push out of the rail.
 */
export function plainStageLabel(label: string): string {
  if (/^Testing\b/.test(label)) return 'Testing which changes fix the bug';
  if (/^Measured \d+ change/.test(label)) return 'Measured which changes fix the bug';
  return label;
}

/** The server labels each ablation build "… (3 of 10, about a minute each)". */
export function ablationProgress(label: string | undefined): { k: number; n: number } | undefined {
  if (scenarioProgress(label)) return undefined; // same "(k of n)" tail, a different stage
  const m = label === undefined ? null : /\((\d+) of (\d+)(?:, [^)]*)?\)\s*$/.exec(label);
  return m ? { k: Number(m[1]), n: Number(m[2]) } : undefined;
}

/** The verifier replays Bob's script once per scenario: "Trying "<title>" on the old and the new version (2 of 3)". */
export function scenarioProgress(label: string | undefined): { k: number; n: number } | undefined {
  const m = label === undefined ? null : /^Trying ".*" on the old and the new version \((\d+) of (\d+)\)\s*$/.exec(label);
  return m ? { k: Number(m[1]), n: Number(m[2]) } : undefined;
}

/** A tool call said for a reader: the file names and commands of Bob's test scripts mean nothing on the screen. */
export function plainTool(tool: string, target: string): string {
  switch (tool) {
    case 'write_file':
    case 'write_to_file':
      return /\.(c|m)?js\b|\.ts\b/.test(target) ? 'Writing a test script' : 'Writing a file';
    case 'execute_command':
      return /\bnode\b/.test(target) ? 'Trying it in the app' : 'Running a command';
    default:
      return target;
  }
}

/** How much of the walkthrough text is usually written when a run is about to finish (a bar needs a guess). */
export const TYPICAL_WRITING_CHARS = 50_000;

/** The log line for a stage: the ablation's file path is dropped, its count ("3 of 10") is kept. */
function feedLabel(label: string): string {
  const a = ablationProgress(label);
  return a ? `${plainStageLabel(label)} (${a.k} of ${a.n})` : label;
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

  const isFactCheck = (label: string) => /^Checking the text/.test(label);
  const inShots = seen.has('app') || seen.has('shots');
  const planned = plan ? plan.shots.planned : undefined;

  // Order the pipeline runs in. `repairing` belongs to whatever is being repaired (the story before the
  // screenshots, the text after them) and must never move the screen backwards.
  const order: StepView['id'][] = ['checkout', 'diff', 'read', 'check', 'shots', 'facts', 'voice'];
  const stageStep = (stage: string, s: { label: string }): StepView['id'] | undefined => {
    switch (stage) {
      case 'clone': return 'checkout';
      case 'hunks': return 'diff';
      case 'analyzing': return 'read';
      case 'validating':
      case 'saving': return 'check';
      case 'repairing': return inShots ? (isFactCheck(s.label) ? 'facts' : 'shots') : 'check';
      case 'app':
      case 'shots': return 'shots';
      case 'voicing': return 'voice';
      default: return undefined;
    }
  };
  let currentIdx = -1;
  for (const s of stages) {
    const step = stageStep(s.stage, s);
    if (step) currentIdx = Math.max(currentIdx, order.indexOf(step));
  }

  // --- the screenshot row decides for itself -------------------------------------------------
  let shotsStatus: StepStatus | undefined;
  let shotsDetail: string | undefined;
  if (outcome) {
    shotsStatus = OUTCOME_STATUS[outcome.code];
    shotsDetail = outcome.message;
    // Work that still belongs to the screenshot stage after the verdict (measuring, revising, checking the text).
    const busy = !done && lastStage && (lastStage.stage === 'shots' || (lastStage.stage === 'repairing' && !isFactCheck(lastStage.label)));
    if (busy && outcome.code === 'ok') shotsDetail = plainStageLabel(lastStage.label);
  } else if (planned === false) {
    shotsStatus = 'skipped';
    shotsDetail = plan?.shots.reason;
  } else if (inShots) {
    shotsStatus = done ? 'done' : 'current';
    const raw = labelOf('shots') ?? labelOf('app');
    shotsDetail = raw === undefined ? undefined : plainStageLabel(raw);
  } else if (planned === true) {
    shotsStatus = 'pending';
    shotsDetail = 'planned — this app can be started';
  }

  // The ablation takes 2 builds per changed hunk, about a minute each: say which build it is on, and how long is left.
  const running = !done && lastStage && lastStage.stage === 'shots' ? ablationProgress(lastStage.label) : undefined;
  const replaying = !done && lastStage && lastStage.stage === 'shots' ? scenarioProgress(lastStage.label) : undefined;
  let shotsProgress: StepView['progress'];
  if (replaying) {
    shotsProgress = replaying.n > 1 ? { done: replaying.k - 1, total: replaying.n } : { indeterminate: true };
    shotsDetail = `Trying the scenario on the old and the new version${replaying.n > 1 ? ` — ${replaying.k} of ${replaying.n}` : ''}`;
    shotsStatus = 'current';
  }
  if (running) {
    shotsProgress = { done: running.k - 1, total: running.n };
    const left = running.n - running.k + 1;
    shotsDetail = `Testing which changes fix the bug — build ${running.k} of ${running.n}, about ${left} min left`;
    shotsStatus = 'current'; // the verdict is in, but the row is still working: keep it pulsing
  }
  // What follows the ablation is known, so name it while it is still ahead: the fact check and the voice-over.
  const ablationSeen = stages.some((s) => s.stage === 'shots' && (ablationProgress(s.label) !== undefined || /^Measured \d+ change/.test(s.label)));
  const expectAfter = !done && (outcome?.code === 'ok' || ablationSeen);
  // The narration is recorded on every run, screenshots or not: the plan says so from the first second.
  const showVoice = seen.has('voicing') || (!done && (plan?.voice ? plan.voice.planned : expectAfter));

  const base: StepView[] = [
    { id: 'checkout', label: 'Checked out the PR', status: 'pending' },
    { id: 'diff', label: 'Split the diff', status: 'pending' },
    { id: 'read', label: 'Reading the code', status: 'pending' },
    { id: 'check', label: 'Checking the story', status: 'pending' },
    { id: 'shots', label: 'Screenshots', status: shotsStatus ?? 'pending' },
    { id: 'facts', label: 'Checking the text against the running app', status: 'pending' },
    { id: 'voice', label: 'Recording the narration', status: 'pending' },
  ];
  const detail: Partial<Record<StepView['id'], string | undefined>> = {
    checkout: labelOf('clone'),
    diff: labelOf('hunks'),
    read: writing ? writingDetail(writing.chars) : undefined,
    check: !inShots ? labelOf('repairing') ?? labelOf('validating') : undefined,
    voice: labelOf('voicing'),
  };
  const writingBar: StepView['progress'] | undefined = writing
    ? writing.chars < TYPICAL_WRITING_CHARS ? { done: writing.chars, total: TYPICAL_WRITING_CHARS } : { indeterminate: true }
    : undefined;
  const steps: StepView[] = [];
  for (const st of base) {
    // Old recordings have no screenshot row unless a screenshot stage ran; the voice row exists only when voicing ran.
    if (st.id === 'shots' && shotsStatus === undefined) continue;
    if (st.id === 'facts' && !stages.some((x) => isFactCheck(x.label)) && !expectAfter) continue;
    if (st.id === 'voice' && !showVoice) continue;
    const idx = order.indexOf(st.id);
    const row = { ...st };
    if (st.id === 'shots') {
      if (shotsDetail) row.detail = shotsDetail;
      if (shotsProgress) row.progress = shotsProgress;
    } else if (done || idx < currentIdx) {
      row.status = 'done';
      if (st.id === 'diff' && detail.diff) row.detail = detail.diff;
    } else if (idx === currentIdx) {
      row.status = 'current';
      if (detail[st.id]) row.detail = detail[st.id];
      if (st.id === 'read' && writingBar) row.progress = writingBar;
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
  // While the app is driven the log mixes the backend's stages with Bob's own tool calls, in plain words.
  const firstShots = events.findIndex((e) => e.kind === 'stage' && (e.stage === 'app' || e.stage === 'shots'));
  const shotsLog: string[] = [];
  if (inShots) {
    events.slice(Math.max(0, firstShots)).forEach((e) => {
      if (e.kind === 'stage' && (e.stage === 'app' || e.stage === 'shots')) shotsLog.push(feedLabel(e.label));
      else if (e.kind === 'tool') {
        const line = plainTool(e.tool, e.target);
        if (shotsLog[shotsLog.length - 1] !== line) shotsLog.push(line);
      }
    });
  }
  const feed = inShots ? shotsLog.slice(-FEED_SIZE) : tools.map((t) => t.target).slice(-FEED_SIZE);
  const pane: PaneView = outcome ? 'outcome' : inShots && !done ? 'reproducing' : 'files';

  return {
    ...(plan ? { pr: plan.pr } : {}),
    ...(plan?.estimate ? { estimate: plan.estimate } : {}),
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
