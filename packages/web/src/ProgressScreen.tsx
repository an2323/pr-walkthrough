/**
 * ProgressScreen — live (or replayed) view of a PR analysis.
 *
 * Route: /:owner/:repo/:number/progress?job=<id>   — live, from POST /api/analyze
 *        /:owner/:repo/:number/progress?replay=1   — replay of a recorded run ($0 demo)
 *
 * Two columns: a rail that says where the run is (steps, time, spend) and a pane that shows what the current
 * step is producing — the changed files while Bob reads, the scenario and two "developing" frames while the
 * app is being driven, then the outcome. The screenshot step can end in six ways, and each has its own calm
 * card: a missing picture is never a silent gap.
 *
 * All the logic is in progressModel.ts (pure, tested); this file only draws it. The event stream is read over
 * SSE; a page reload reconnects to the same URL and gets the full backlog again.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProgressEvent } from '@pr-walkthrough/shared';
import { STATIC, recordingUrl, apiUrl, shotUrl } from './staticMode';
import { deriveProgressView, type FileView, type ProgressView, type StepView } from './progressModel';
import { BrandLink } from './BrandLink';
import './ProgressScreen.css';

/** Static build only — mirrors REPLAY_TARGET_MS in the server's replay route. */
const STATIC_REPLAY_TARGET_MS = 20_000;
/** No new event for this long (a live run): say calmly that it is still working. */
const QUIET_AFTER_MS = 60_000;
/** How long the finished state stays before the viewer opens (the button opens it at once). */
const AUTO_NAVIGATE_MS = 3500;

interface Props {
  owner: string;
  repo: string;
  number: number;
}

function fmtElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

export function ProgressScreen({ owner, repo, number }: Props) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [connectionLost, setConnectionLost] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastEventAtRef = useRef(Date.now());
  const gotAnyEventRef = useRef(false);

  const search = new URLSearchParams(window.location.search);
  const jobId = search.get('job');
  const isReplay = search.get('replay') != null;
  const speed = search.get('speed'); // optional override, forwarded to the replay endpoint as-is
  // A rehearsal's result is stored apart from the real walkthrough — keep pointing at it.
  const viewerPath = `/${owner}/${repo}/${number}${search.get('rehearsal') ? '?rehearsal=1' : ''}`;

  const push = (e: ProgressEvent) => {
    lastEventAtRef.current = Date.now();
    setEvents((prev) => [...prev, e]);
  };

  // ---- Static build: replay the recording in the browser, paced like the server's replay ----
  useEffect(() => {
    if (!STATIC) return;
    if (!isReplay) {
      setConnectionLost(true);
      return;
    }
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    fetch(recordingUrl(owner, repo, number))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((raw) => {
        if (cancelled) return;
        const recorded = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ProgressEvent);
        const t0 = recorded[0]?.t ?? 0;
        const totalMs = recorded.length > 0 ? recorded[recorded.length - 1].t : 0;
        const rate = Number(speed) > 0 ? Number(speed) : Math.max(1, totalMs / STATIC_REPLAY_TARGET_MS);
        for (const e of recorded) timers.push(setTimeout(() => push(e), (e.t - t0) / rate));
      })
      .catch(() => { if (!cancelled) setConnectionLost(true); });
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, number, isReplay, speed]);

  // ---- SSE subscription ----
  useEffect(() => {
    if (STATIC) return;
    const url = isReplay
      ? apiUrl(`/api/runs/${owner}/${repo}/${number}/events${speed ? `?speed=${encodeURIComponent(speed)}` : ''}`)
      : jobId
      ? apiUrl(`/api/jobs/${jobId}/events`)
      : null;
    if (!url) {
      setConnectionLost(true);
      return;
    }

    const es = new EventSource(url);
    // The server sends the whole backlog again on every (re)connect, so a reconnect must start from
    // nothing — otherwise every event would be there twice.
    let opened = 0;
    es.onopen = () => {
      opened += 1;
      if (opened > 1) setEvents([]);
    };
    es.onmessage = (msg: MessageEvent<string>) => {
      gotAnyEventRef.current = true;
      setConnectionLost(false);
      let e: ProgressEvent;
      try {
        e = JSON.parse(msg.data) as ProgressEvent;
      } catch {
        return; // malformed line — ignore rather than crash the screen
      }
      push(e);
      if (e.kind === 'done' || e.kind === 'error') es.close();
    };
    es.onerror = () => {
      // EventSource retries on its own; only treat this as fatal if we never received anything.
      if (!gotAnyEventRef.current) setConnectionLost(true);
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, number, jobId, isReplay, speed]);

  // ---- Clock: server time of the latest event, plus the time since it arrived (live runs only) ----
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const view = useMemo(() => deriveProgressView(events), [events]);

  // ---- Auto-navigate to the viewer once done ----
  useEffect(() => {
    if (!view.done) return;
    const id = setTimeout(() => {
      window.location.href = viewerPath;
    }, AUTO_NAVIGATE_MS);
    return () => clearTimeout(id);
  }, [view.done, viewerPath]);

  if (view.error) {
    return (
      <div className="pg pg--center">
        <div className="pg-fail">
          <h2>The analysis didn't finish</h2>
          <p>{view.error}</p>
          <a className="v2btn" href="/">← Back</a>
        </div>
      </div>
    );
  }

  const elapsed = view.done
    ? view.done.durationMs
    : view.elapsedMs + (isReplay ? 0 : Math.max(0, now - lastEventAtRef.current));

  return (
    <div className="pg">
      <header className="pg-head">
        <BrandLink className="pg-brand" />
        <span className="pg-ref">{owner}/{repo} <b>#{number}</b></span>
      </header>
      {connectionLost && <p className="pg-lost">Lost connection to the server — retrying…</p>}
      <div className="pg-grid">
        <Rail view={view} owner={owner} repo={repo} number={number} elapsed={elapsed} quietMs={isReplay || view.done ? 0 : Math.max(0, now - lastEventAtRef.current)} />
        <main className="pg-pane">
          {view.done && (
            <div className="pg-done">
              <span>
                Done · {fmtElapsed(view.done.durationMs)}
                {view.done.costUsd !== undefined && ` · $${view.done.costUsd.toFixed(2)}`}
                {view.done.toolCalls !== undefined && ` · ${view.done.toolCalls} tool calls`}
              </span>
              <a className="v2btn primary" href={viewerPath}>Open the walkthrough →</a>
            </div>
          )}
          <Pane view={view} owner={owner} repo={repo} number={number} />
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------------------------

function Rail({ view, owner, repo, number, elapsed, quietMs }: { view: ProgressView; owner: string; repo: string; number: number; elapsed: number; quietMs: number }) {
  return (
    <aside className="pg-rail" aria-label="Progress">
      <div className="pg-pr">
        <div className="pg-pr-name">{owner}/{repo} <span>#{number}</span></div>
        {view.pr && (
          <div className="pg-pr-sub">
            {view.pr.title} · <span className="pg-add">+{view.pr.additions}</span> <span className="pg-del">−{view.pr.deletions}</span>
            {' · '}{view.pr.files} file{view.pr.files === 1 ? '' : 's'}
          </div>
        )}
      </div>
      <div className="pg-meters">
        <div className="pg-meter"><span>elapsed</span><b>{fmtElapsed(elapsed)}</b></div>
        {view.costUsd !== undefined && (
          <div className="pg-meter pg-meter--grow">
            <span>spent</span>
            <b>${view.costUsd.toFixed(2)}</b>
          </div>
        )}
      </div>
      {view.estimate && !view.done && (
        <p className="pg-est">
          about {view.estimate.minMinutes}–{view.estimate.maxMinutes} min for this PR
          {view.estimate.coldInstall && <small>First run for this version installs the app (+3–5 min).</small>}
        </p>
      )}
      <ol className="pg-steps">
        {view.steps.map((s) => <Step key={s.id} step={s} />)}
      </ol>
      {quietMs > QUIET_AFTER_MS && !view.steps.some((st) => st.status === 'current' && st.progress && 'total' in st.progress) && (
        <p className="pg-why pg-why--calm" role="status">
          {view.steps.find((st) => st.status === 'current')?.id === 'read'
            ? 'Still writing — long answers take a few minutes.'
            : 'Still working — this step takes a few minutes. Nothing is stuck.'}
        </p>
      )}
      {view.shots.planned && !view.done && !view.shots.outcome && (
        <p className="pg-why">Screenshots are a bonus: if they don't work out, you still get the full walkthrough.</p>
      )}
      {view.subagents > 0 && <p className="pg-why pg-why--quiet">{view.subagents} sub-agent{view.subagents === 1 ? '' : 's'} helping</p>}
    </aside>
  );
}

const MARK: Record<StepView['status'], string> = { done: '✓', current: '', pending: '', skipped: '–', warn: '!' };

/** A known fraction fills the bar; otherwise it just moves, so a long step never looks frozen. */
function StepBar({ progress }: { progress: NonNullable<StepView['progress']> }) {
  if ('indeterminate' in progress) return <i className="pg-stepbar pg-stepbar--alive" role="progressbar" aria-label="Working"><i /></i>;
  const pct = Math.max(3, Math.min(100, (progress.done / progress.total) * 100));
  return (
    <i className="pg-stepbar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
      <i style={{ width: `${pct}%` }} />
    </i>
  );
}

function Step({ step }: { step: StepView }) {
  return (
    <li className={`pg-step pg-step--${step.status}`}>
      <span className="pg-dot" aria-hidden="true">{MARK[step.status]}</span>
      <span className="pg-step-label">{step.label}</span>
      {step.detail && <small>{step.detail}</small>}
      {step.progress && <StepBar progress={step.progress} />}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------------------------

interface PaneProps {
  view: ProgressView;
  owner: string;
  repo: string;
  number: number;
}

function Pane(props: PaneProps) {
  switch (props.view.pane) {
    case 'reproducing': return <ReproducingPane {...props} />;
    case 'outcome': return <OutcomePane {...props} />;
    default: return <FilesPane {...props} />;
  }
}

function FileRow({ f }: { f: FileView }) {
  const icon = f.status === 'read' ? '✓' : f.status === 'reading' ? '●' : f.status === 'hidden' ? '–' : '○';
  return (
    <li className={`pg-file pg-file--${f.status}`}>
      <span className="pg-file-icon" aria-hidden="true">{icon}</span>
      <code>{f.path}</code>
      {f.status === 'reading' && <span className="pg-chip">Bob is here</span>}
      {f.status === 'hidden' ? (
        <span className="pg-file-note">skipped — mechanical</span>
      ) : (
        <span className="pg-file-pm"><span className="pg-add">+{f.additions}</span> <span className="pg-del">−{f.deletions}</span></span>
      )}
    </li>
  );
}

function Feed({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="pg-feed" aria-label="Recent actions">
      {lines.map((l, i) => (
        <div key={i} className={i === lines.length - 1 ? 'pg-feed-now' : undefined}>{l}</div>
      ))}
    </div>
  );
}

function Scenario({ lines, title, tone }: { lines: string[]; title: string; tone?: 'quiet' }) {
  if (lines.length === 0) return null;
  return (
    <section className={`pg-card${tone ? ` pg-card--${tone}` : ''}`}>
      <h4>{title}</h4>
      <ol className="pg-scenario">{lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
    </section>
  );
}

function FilesPane({ view }: PaneProps) {
  const reading = view.files.length > 0;
  return (
    <>
      <div className="pg-pane-head">
        <h3>{reading ? 'What changed in the PR' : 'Getting started'}</h3>
        {reading && <span>the highlighted file is the one Bob is reading now</span>}
      </div>
      {reading ? (
        <ul className="pg-files">{view.files.map((f) => <FileRow key={f.path} f={f} />)}</ul>
      ) : (
        <p className="pg-quiet">Bob is getting the PR ready. The changed files will appear here in a moment.</p>
      )}
      <Feed lines={view.feed} />
      {view.shots.planned && <Scenario lines={view.scenario} title="What Bob will try in the running app" tone="quiet" />}
    </>
  );
}

function Developing({ side, label }: { side: 'before' | 'after'; label: string }) {
  return (
    <div className={`pg-slot pg-slot--${side}`}>
      <div className="pg-slot-lab"><b>{side === 'before' ? 'Before' : 'After'}</b><small>{label}</small></div>
      <div className="pg-frame"><div className="pg-shimmer">developing…</div></div>
    </div>
  );
}

function ReproducingPane({ view }: PaneProps) {
  return (
    <>
      <div className="pg-pane-head">
        <h3>Reproducing the bug</h3>
        <span>the pictures appear together when both versions have been tried</span>
      </div>
      <Scenario lines={view.scenario} title="What Bob is trying" />
      <div className="pg-slots">
        <Developing side="before" label="old commit" />
        <Developing side="after" label="PR commit" />
      </div>
      <Feed lines={view.feed} />
    </>
  );
}

const OUTCOME_TITLE: Record<string, string> = {
  ok: 'Reproduced, and the fix holds',
  identical: "It's proven, but not visible",
  'no-recipe': 'Walkthrough only',
  'non-visual': 'A change with nothing to see',
  'app-failed': "Couldn't start the app",
  'not-reproduced': "Bob couldn't trigger the bug",
  unavailable: 'Screenshots unavailable',
};

const OUTCOME_TONE: Record<string, 'good' | 'info' | 'warn'> = {
  ok: 'good',
  identical: 'good',
  'no-recipe': 'info',
  'non-visual': 'info',
  'app-failed': 'warn',
  'not-reproduced': 'warn',
  unavailable: 'warn',
};

const OUTCOME_TAIL: Record<string, string> = {
  'no-recipe': 'You still get the full narrated walkthrough.',
  'non-visual': 'The proof comes from the code and its tests instead.',
  'app-failed': 'The walkthrough is unaffected.',
  'not-reproduced': 'The walkthrough says so in plain words; it is not counted against the PR.',
  unavailable: 'The walkthrough is unaffected.',
};

function OutcomePane({ view, owner, repo, number }: PaneProps) {
  const o = view.shots.outcome!;
  const tone = OUTCOME_TONE[o.code] ?? 'info';
  const frames = view.shots.frames;
  return (
    <>
      <div className="pg-pane-head">
        <h3>{OUTCOME_TITLE[o.code] ?? 'Screenshots'}</h3>
        {o.code === 'ok' && <span>same clicks on the old and the new commit</span>}
      </div>
      {frames && (
        <div className="pg-slots">
          <FrameSlot side="before" label="old commit" src={shotUrl(owner, repo, number, frames.before)} />
          <FrameSlot side="after" label="PR commit" src={shotUrl(owner, repo, number, frames.after)} />
        </div>
      )}
      <div className={`pg-note pg-note--${tone}`}>
        {o.message}
        {OUTCOME_TAIL[o.code] && <> {OUTCOME_TAIL[o.code]}</>}
      </div>
      {(o.code === 'not-reproduced' || o.code === 'app-failed') && <Scenario lines={view.scenario} title="What Bob tried" tone="quiet" />}
      {!view.done && view.feed.length > 0 && <Feed lines={view.feed.slice(-2)} />}
    </>
  );
}

function FrameSlot({ side, label, src }: { side: 'before' | 'after'; label: string; src: string }) {
  return (
    <div className={`pg-slot pg-slot--${side}`}>
      <div className="pg-slot-lab"><b>{side === 'before' ? 'Before' : 'After'}</b><small>{label}</small></div>
      <div className="pg-frame"><img src={src} alt={`${side === 'before' ? 'Before' : 'After'} screenshot`} /></div>
    </div>
  );
}
