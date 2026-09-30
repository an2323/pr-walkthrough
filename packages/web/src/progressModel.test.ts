import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProgressEvent } from '@pr-walkthrough/shared';

import { ablationProgress, deriveProgressView, plainStageLabel, plainTool, scenarioProgress } from './progressModel';

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

describe('plainStageLabel — the rail never shows a file path or a hunk id', () => {
  it('says the ablation in plain words', () => {
    expect(plainStageLabel('Testing "packages/excalidraw/components/dropdownMenu/DropdownMenuTrigger.tsx#1" alone')).toBe('Testing which changes fix the bug');
    expect(plainStageLabel('Testing everything except "packages/x/y.ts#2"')).toBe('Testing which changes fix the bug');
    expect(plainStageLabel('Measured 4 change(s) against the running app')).toBe('Measured which changes fix the bug');
  });
  it('leaves ordinary labels alone', () => {
    expect(plainStageLabel('Bob is reproducing the change and taking screenshots')).toBe('Bob is reproducing the change and taking screenshots');
  });
  it('the screenshot row shows the plain label while the ablation runs, before and after the verdict', () => {
    t = 0;
    const path = 'Testing "packages/excalidraw/components/dropdownMenu/DropdownMenuTrigger.tsx#1" alone';
    const running = deriveProgressView([stage('clone'), plan(true), stage('shots', path)]);
    expect(running.steps.find((s) => s.id === 'shots')?.detail).toBe('Testing which changes fix the bug');
    const later = deriveProgressView([stage('clone'), plan(true), stage('shots'), outcome('ok', 'ok'), stage('shots', path)]);
    expect(later.steps.find((s) => s.id === 'shots')?.detail).toBe('Testing which changes fix the bug');
  });
});

describe('the long waits say what they are doing and what is left', () => {
  const build = (k: number, n: number) => stage('shots', `Testing "packages/x/y.ts#1" alone (${k} of ${n}, about a minute each)`);
  const okRun = () => [stage('clone'), plan(true), stage('shots'), outcome('ok', 'ok')];

  it('reads "k of n" from the server label', () => {
    expect(ablationProgress('Testing everything except "a#2" (3 of 10, about a minute each)')).toEqual({ k: 3, n: 10 });
    expect(ablationProgress('Testing "a#1" alone')).toBeUndefined();
    expect(ablationProgress(undefined)).toBeUndefined();
  });

  it('the ablation is a count and a bar, with the time left', () => {
    t = 0;
    const v = deriveProgressView([...okRun(), build(3, 10)]);
    const row = v.steps.find((s) => s.id === 'shots')!;
    expect(row.progress).toEqual({ done: 2, total: 10 });
    expect(row.detail).toBe('Testing which changes fix the bug — build 3 of 10, about 8 min left');
    expect(row.detail).not.toMatch(/packages|#1/);
    expect(row.status).toBe('current');
    expect(v.feed.at(-1)).toBe('Testing which changes fix the bug (3 of 10)');
  });

  it('once the ablation is over the bar is gone', () => {
    t = 0;
    const v = deriveProgressView([...okRun(), build(10, 10), stage('shots', 'Measured 5 change(s) against the running app')]);
    expect(v.steps.find((s) => s.id === 'shots')?.progress).toBeUndefined();
  });

  it('names the stages that are still ahead, in order', () => {
    t = 0;
    const v = deriveProgressView([...okRun(), build(1, 4)]);
    const tail = v.steps.slice(-3);
    expect(tail.map((s) => [s.id, s.status])).toEqual([['shots', 'current'], ['facts', 'pending'], ['voice', 'pending']]);
    expect(tail[1].label).toBe('Checking the text against the running app');
    expect(tail[2].label).toBe('Recording the narration');
  });

  it('the fact check is its own step, not a detail of the screenshots', () => {
    t = 0;
    const v = deriveProgressView([...okRun(), stage('repairing', 'Checking the text against the running app')]);
    expect(status(v, 'facts')).toBe('current');
    expect(status(v, 'voice')).toBe('pending');
    expect(v.steps.find((s) => s.id === 'shots')?.detail).toBe('ok');
    const later = deriveProgressView([...okRun(), stage('repairing', 'Checking the text against the running app'), stage('voicing', 'Recording the narration')]);
    expect(['facts', 'voice'].map((id) => status(later, id))).toEqual(['done', 'current']);
  });

  it('a finished run shows no stage that never ran', () => {
    t = 0;
    const v = deriveProgressView([...okRun(), at({ kind: 'done', walkthroughUrl: '/x', durationMs: 5000 })]);
    expect(v.steps.map((s) => s.id)).not.toContain('facts');
    expect(v.steps.map((s) => s.id)).not.toContain('voice');
  });

  it('writing: a bar grows with the characters, then only says it is still alive', () => {
    t = 0;
    const w = (chars: number) => deriveProgressView([stage('clone'), stage('analyzing'), at({ kind: 'writing', chars })]).steps.find((s) => s.id === 'read')!;
    expect(w(25_000).progress).toEqual({ done: 25_000, total: 50_000 });
    expect(w(25_000).detail).toBe('Bob is writing the walkthrough — about 25,000 of ~50,000 characters');
    expect(w(61_000).progress).toEqual({ indeterminate: true });
    expect(w(61_000).detail).toBe('Bob is still writing — 61,000 characters so far');
  });
});

describe('narration, the estimate and the screenshot stage are visible from the start', () => {
  const planWith = (extra: Record<string, unknown>) =>
    at({ kind: 'plan', pr: { title: 'fix', additions: 3, deletions: 1, files: 1 }, shots: { planned: true }, ...extra });

  it('the narration row is there from the first second when the plan says so, for runs without screenshots too', () => {
    t = 0;
    const v = deriveProgressView([stage('clone'), planWith({ voice: { planned: true } })]);
    expect(v.steps.at(-1)).toMatchObject({ id: 'voice', label: 'Recording the narration', status: 'pending' });
    // …while the ablation and the fact check still wait for the screenshot verdict
    expect(v.steps.map((s) => s.id)).not.toContain('facts');
    const noShots = deriveProgressView([stage('clone'), at({ kind: 'plan', pr: { title: 'x', additions: 1, deletions: 0, files: 1 }, shots: { planned: false, reason: 'r' }, voice: { planned: true } })]);
    expect(noShots.steps.map((s) => s.id)).toContain('voice');
  });

  it('no narration row when the server will not record one', () => {
    t = 0;
    const v = deriveProgressView([stage('clone'), planWith({ voice: { planned: false } }), stage('shots'), outcome('ok', 'ok')]);
    expect(v.steps.map((s) => s.id)).not.toContain('voice');
  });

  it('passes the estimate on', () => {
    t = 0;
    const estimate = { minMinutes: 16, maxMinutes: 29, ablationBuilds: 10, coldInstall: true };
    expect(deriveProgressView([planWith({ estimate })]).estimate).toEqual(estimate);
    expect(deriveProgressView([planWith({})]).estimate).toBeUndefined();
  });

  it('each scenario replay is a counted row', () => {
    t = 0;
    expect(scenarioProgress('Trying "Open the menu" on the old and the new version (2 of 3)')).toEqual({ k: 2, n: 3 });
    expect(scenarioProgress('Testing "a#1" alone (2 of 3, about a minute each)')).toBeUndefined();
    const v = deriveProgressView([stage('clone'), planWith({}), stage('shots', 'Trying "Open the menu" on the old and the new version (2 of 3)')]);
    const row = v.steps.find((s) => s.id === 'shots')!;
    expect(row).toMatchObject({ status: 'current', progress: { done: 1, total: 3 }, detail: 'Trying the scenario on the old and the new version — 2 of 3' });
  });

  it("Bob's own tool calls in the screenshot stage are said in plain words", () => {
    expect(plainTool('write_file', 'Writing repro.cjs')).toBe('Writing a test script');
    expect(plainTool('execute_command', 'Running `node repro.cjs --base`')).toBe('Trying it in the app');
    expect(plainTool('read_file', 'Reading src/a.ts')).toBe('Reading src/a.ts');
    t = 0;
    const v = deriveProgressView([
      stage('clone'), planWith({}), tool('Reading before.ts'),
      stage('shots', 'Bob is reproducing the change'), tool('Writing repro.cjs', 'write_file'), tool('Running `node repro.cjs`', 'execute_command'), tool('Reading src/a.ts'),
    ]);
    expect(v.feed).toEqual(['Bob is reproducing the change', 'Writing a test script', 'Trying it in the app', 'Reading src/a.ts']);
  });
});
