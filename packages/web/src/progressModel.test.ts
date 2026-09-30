import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProgressEvent } from '@pr-walkthrough/shared';

import { deriveProgressView } from './progressModel';

let t = 0;
const at = (e: Record<string, unknown>): ProgressEvent => ({ ...e, t: (t += 1000) }) as ProgressEvent;
const stage = (s: string, label = s) => at({ kind: 'stage', stage: s, label });
const tool = (target: string, name = 'read_file') => at({ kind: 'tool', tool: name, target });
const plan = (planned: boolean, reason?: string) =>
  at({ kind: 'plan', pr: { title: 'fix: x', additions: 30, deletions: 7, files: 2 }, shots: { planned, ...(reason ? { reason } : {}) } });
const files = (...f: [string, boolean?][]) =>
  at({ kind: 'files', files: f.map(([path, skipped]) => ({ path, additions: 5, deletions: 1, skipped: !!skipped })) });
const outcome = (code: string, message: string) => at({ kind: 'outcome', what: 'shots', code, message });
const status = (v: ReturnType<typeof deriveProgressView>, id: string) => v.steps.find((s) => s.id === id)?.status;

describe('deriveProgressView — an old recording (no plan, files or outcome)', () => {
  const raw = readFileSync(new URL('../../../data/events/excalidraw/excalidraw/10295.ndjson', import.meta.url), 'utf-8');
  const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ProgressEvent);

  it('still shows the stage list it always had, without a screenshot row', () => {
    const v = deriveProgressView(events);
    expect(v.steps.map((s) => s.id)).toEqual(['checkout', 'diff', 'read', 'check']);
    expect(v.steps.every((s) => s.status === 'done')).toBe(true);
    expect(v.pane).toBe('files');
    expect(v.done).toBeDefined();
    expect(v.files).toEqual([]);
    expect(v.subagents).toBe(2);
    expect(v.costUsd).toBeCloseTo(2.529143, 5);
  });

  it('mid-run: the current step is the last stage that started', () => {
    const upTo = events.findIndex((e) => e.kind === 'stage' && e.stage === 'validating');
    const v = deriveProgressView(events.slice(0, upTo + 1));
    expect(status(v, 'read')).toBe('done');
    expect(status(v, 'check')).toBe('current');
    expect(v.done).toBeUndefined();
  });
});

describe('deriveProgressView — a run with the structured events', () => {
  it('second zero: the plan says screenshots are planned, nothing else has happened', () => {
    t = 0;
    const v = deriveProgressView([stage('clone', 'Preparing the git workspace'), plan(true)]);
    expect(v.pr).toMatchObject({ title: 'fix: x', files: 2 });
    expect(v.shots.planned).toBe(true);
    expect(v.steps.find((s) => s.id === 'shots')).toMatchObject({ status: 'pending', detail: expect.stringMatching(/planned/) });
    expect(status(v, 'checkout')).toBe('current');
    expect(v.pane).toBe('files');
  });

  it('reading: files are marked hidden / reading / read from the tool targets', () => {
    t = 0;
    const v = deriveProgressView([
      stage('clone'), plan(true), files(['src/a.ts'], ['src/b.ts'], ['yarn.lock', true], ['src/c.ts']), stage('hunks', '4 hunks'), stage('analyzing'),
      tool('Reading .walkthrough/pr.diff'), tool('Reading src/a.ts'), tool('Reading .walkthrough/base/src/b.ts'),
    ]);
    const byPath = Object.fromEntries(v.files.map((f) => [f.path, f.status]));
    expect(byPath).toEqual({ 'src/a.ts': 'read', 'src/b.ts': 'reading', 'yarn.lock': 'hidden', 'src/c.ts': 'todo' });
    expect(status(v, 'read')).toBe('current');
    expect(v.feed.at(-1)).toBe('Reading .walkthrough/base/src/b.ts');
  });

  it('screenshot stage running: reproducing pane, scenario known, no frames yet', () => {
    t = 0;
    const v = deriveProgressView([
      stage('clone'), plan(true), stage('analyzing'), at({ kind: 'scenario', lines: ['Open the menu', 'Check the picker'] }),
      stage('saving'), stage('app', 'Starting the app at BASE and HEAD'), stage('shots', 'Bob is reproducing the change and taking screenshots'),
    ]);
    expect(v.pane).toBe('reproducing');
    expect(v.scenario).toEqual(['Open the menu', 'Check the picker']);
    expect(v.shots.frames).toBeUndefined();
    expect(v.steps.find((s) => s.id === 'shots')).toMatchObject({ status: 'current', detail: 'Bob is reproducing the change and taking screenshots' });
    expect(status(v, 'check')).toBe('done');
  });

  it('outcome ok: frames land, the step is done, later work shows as its detail', () => {
    t = 0;
    const events: ProgressEvent[] = [
      stage('clone'), plan(true), stage('shots', 'Bob is reproducing…'),
      at({ kind: 'frames', before: 'before-annotated.png', after: 'after-annotated.png', caption: 'c' }),
      outcome('ok', 'The bug reproduced at the old commit and is gone at the new one.'),
      stage('shots', 'Testing which changes fix the bug'),
    ];
    const v = deriveProgressView(events);
    expect(v.pane).toBe('outcome');
    expect(v.shots.frames).toEqual({ before: 'before-annotated.png', after: 'after-annotated.png', caption: 'c' });
    expect(v.steps.find((s) => s.id === 'shots')).toMatchObject({ status: 'done', detail: 'Testing which changes fix the bug' });
    // once voicing starts the screenshot row shows the verdict again, not an old sub-step
    const v2 = deriveProgressView([...events, stage('voicing', 'Recording the narration')]);
    expect(v2.steps.find((s) => s.id === 'shots')?.detail).toMatch(/reproduced at the old commit/);
    expect(status(v2, 'voice')).toBe('current');
  });

  it('a repair after the screenshots does not move the screen back to "checking the story"', () => {
    t = 0;
    const v = deriveProgressView([stage('saving'), plan(true), stage('shots'), outcome('ok', 'ok'), stage('repairing', 'Revising the explanation from measured evidence')]);
    expect(status(v, 'check')).toBe('done');
    expect(v.steps.find((s) => s.id === 'shots')?.detail).toBe('Revising the explanation from measured evidence');
  });

  it('not planned for this repository: the row is skipped from the start, with the reason', () => {
    t = 0;
    const why = "this repository isn't set up for automatic screenshots.";
    const v = deriveProgressView([stage('clone'), plan(false, why), stage('analyzing')]);
    expect(v.steps.find((s) => s.id === 'shots')).toMatchObject({ status: 'skipped', detail: why });
    expect(v.shots.planned).toBe(false);
    expect(v.pane).toBe('files');
  });

  it.each([
    ['no-recipe', 'skipped'],
    ['non-visual', 'skipped'],
    ['app-failed', 'warn'],
    ['not-reproduced', 'warn'],
    ['unavailable', 'warn'],
    ['identical', 'done'],
    ['ok', 'done'],
  ])('outcome %s → the screenshot row is %s', (code, expected) => {
    t = 0;
    const v = deriveProgressView([stage('shots'), plan(true), outcome(code, 'A sentence.')]);
    expect(status(v, 'shots')).toBe(expected);
    expect(v.shots.outcome).toEqual({ code, message: 'A sentence.' });
    expect(v.pane).toBe('outcome');
  });

  it('done: every stage step is done, the outcome card stays', () => {
    t = 0;
    const v = deriveProgressView([
      stage('clone'), plan(true), stage('shots'), outcome('not-reproduced', 'Bob could not trigger the bug.'),
      stage('voicing'), at({ kind: 'cost', costUsd: 0.9, maxCostUsd: 1.5 }), at({ kind: 'done', walkthroughUrl: '/x', durationMs: 5000, costUsd: 0.9 }),
    ]);
    expect(v.done).toBeDefined();
    expect(['checkout', 'read', 'check', 'voice'].map((id) => status(v, id))).toEqual(['done', 'done', 'done', 'done']);
    expect(status(v, 'shots')).toBe('warn');
    expect(v.pane).toBe('outcome');
    expect(v.costUsd).toBe(0.9);
    expect(v.maxCostUsd).toBe(1.5);
  });

  it('an error event is reported as a message', () => {
    t = 0;
    expect(deriveProgressView([stage('clone'), at({ kind: 'error', message: 'GitHub said no' })]).error).toBe('GitHub said no');
  });

  it('an empty stream is an empty, valid view', () => {
    const v = deriveProgressView([]);
    expect(v.steps.map((s) => s.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(v.elapsedMs).toBe(0);
  });
});
