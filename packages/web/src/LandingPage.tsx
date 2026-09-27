/**
 * LandingPage — shown at "/" when no PR URL is present in the path.
 *
 * Static demo: cards for the cached walkthroughs only. Non-static: a GitHub PR
 * URL input that starts a live analysis (ST6c).
 *
 * Cards show real numbers (cost, duration, sub-agents) fetched from each
 * walkthrough's own JSON — not a hand-written blurb that can drift from what
 * the run actually did.
 */

import { useState, useEffect } from 'react';
import type { Walkthrough } from '@pr-walkthrough/shared';
import { STATIC, walkthroughUrl, shotUrl } from './staticMode';

interface ExampleCard {
  owner: string;
  repo: string;
  number: number;
  primary?: boolean;
  /** Whether a recorded analysis run exists at data/events/{owner}/{repo}/{number}.ndjson (ST6c). */
  hasReplay?: boolean;
}

const EXAMPLES: ExampleCard[] = [
  {
    owner: 'excalidraw',
    repo: 'excalidraw',
    number: 10943,
    primary: true,
    // No recorded run to replay yet — its original live analysis hit the disk-full
    // incident right as it tried to persist progress.ndjson (see cost-log-stage2.md).
    hasReplay: false,
  },
  {
    owner: 'excalidraw',
    repo: 'excalidraw',
    number: 10295,
    hasReplay: true,
  },
  {
    owner: 'excalidraw',
    repo: 'excalidraw',
    number: 8340,
    hasReplay: true,
  },
];

function parsePRUrl(raw: string): { owner: string; repo: string; number: number } | null {
  const trimmed = raw.trim().replace(/\/$/, '');
  // https://github.com/owner/repo/pull/123
  const m = trimmed.match(
    /(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/
  );
  if (m) return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
  // owner/repo#123 shorthand
  const s = trimmed.match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/);
  if (s) return { owner: s[1], repo: s[2], number: parseInt(s[3], 10) };
  return null;
}

function cardHref(c: ExampleCard): string {
  return `/${c.owner}/${c.repo}/${c.number}`;
}

function apiHref(c: ExampleCard): string {
  return walkthroughUrl(c.owner, c.repo, c.number);
}

function replayHref(c: ExampleCard): string {
  return `/${c.owner}/${c.repo}/${c.number}/progress?replay=1`;
}

function fmtCost(usd?: number): string | null {
  return usd === undefined ? null : `$${usd.toFixed(2)}`;
}
function fmtDuration(ms?: number): string | null {
  if (ms === undefined) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const HOW_IT_WORKS = [
  { n: '1', t: 'Bob reads the PR', d: 'The diff, the commit history, and any file in the repo it needs — not just the changed lines.' },
  { n: '2', t: 'Bob checks its own story', d: 'It starts the app at both versions and re-tests which changes the fix actually needs, instead of only guessing from the code.' },
  { n: '3', t: 'You get a walkthrough', d: 'Ordered by reasoning, narrated, with the evidence attached to every step that has it.' },
];

export function LandingPage() {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [cards, setCards] = useState<Record<string, Walkthrough | null | undefined>>({});

  // Fetch each example's own JSON once (undefined = loading, null = unavailable) — the
  // card's numbers and title come from here, never a hand-written description.
  useEffect(() => {
    for (const card of EXAMPLES) {
      const key = cardHref(card);
      fetch(apiHref(card))
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then((wt: Walkthrough) => setCards((prev) => ({ ...prev, [key]: wt })))
        .catch(() => setCards((prev) => ({ ...prev, [key]: null })));
    }
  }, []);

  const [starting, setStarting] = useState(false);

  // If the PR is already cached, jump straight to the viewer (today's
  // behaviour). Otherwise kick off a job via POST /api/analyze and go to the
  // live progress screen (ST6c) instead of blocking on a 3+ minute request.
  async function handleGo() {
    const parsed = parsePRUrl(input);
    if (!parsed) {
      setError('Enter a GitHub PR URL like https://github.com/owner/repo/pull/123');
      return;
    }
    setError('');
    const viewerPath = `/${parsed.owner}/${parsed.repo}/${parsed.number}`;

    setStarting(true);
    try {
      const probe = await fetch(`/api/walkthroughs/${parsed.owner}/${parsed.repo}/${parsed.number}`, { method: 'HEAD' });
      if (probe.ok) {
        window.location.href = viewerPath;
        return;
      }
    } catch {
      // couldn't reach the API to check — fall through and try to start an analysis anyway
    }

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prUrl: input.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setError(body.error ?? `Could not start analysis (HTTP ${res.status})`);
        setStarting(false);
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      window.location.href = `${viewerPath}/progress?job=${jobId}`;
    } catch {
      setError('Could not reach the server to start analysis.');
      setStarting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') void handleGo();
  }

  return (
    <div className="landing">
      <nav className="landing-nav">
        <span className="landing-brand">PR Walkthrough</span>
        <span className="landing-nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="https://github.com/an2323/pr-walkthrough" target="_blank" rel="noopener noreferrer">
            GitHub ↗
          </a>
        </span>
      </nav>

      <div className="landing-hero">
        <h1 className="landing-title">Stop reverse-engineering pull requests.<br />Let Bob walk you through them.</h1>
        {STATIC ? (
          <>
            <p className="landing-sub">
              A narrated tour of a pull request — what broke, why, and how the fix lands —
              written by IBM Bob 2.0 with the whole repository in view.
            </p>
            <p className="landing-note">
              This demo ships finished walkthroughs; paste-a-PR needs a local/server build.
            </p>
          </>
        ) : (
          <p className="landing-sub">
            Paste a GitHub pull request URL to get a narrated, step-by-step walkthrough
            written by IBM Bob 2.0.
          </p>
        )}

        {!STATIC && (<>
        <div className="landing-input-row">
          <input
            className="landing-input"
            type="text"
            placeholder="https://github.com/owner/repo/pull/123"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            aria-label="GitHub PR URL"
          />
          <button className="v2btn primary" onClick={() => void handleGo()} disabled={starting}>
            {starting ? 'Starting…' : 'Analyse →'}
          </button>
        </div>
        {error && <p className="landing-error">{error}</p>}
        </>)}
      </div>

      <div className="landing-examples">
        <h2 className="landing-examples-h">Try a walkthrough</h2>
        <div className="landing-cards">
          {EXAMPLES.map((card) => {
            const key = cardHref(card);
            const wt = cards[key]; // undefined = loading, null = unavailable, else the JSON
            if (STATIC && wt === null) return null;
            const cost = fmtCost(wt?.meta.run?.costUsd);
            const dur = fmtDuration(wt?.meta.run?.durationMs);
            const subagents = wt?.meta.run?.subagents;
            const thumb = wt?.shots?.before;
            return (
              <div className={`landing-card${card.primary ? ' landing-card-primary' : ''}`} key={key}>
                {thumb && (
                  <img className="landing-card-thumb" src={shotUrl(card.owner, card.repo, card.number, thumb.src)} alt="" />
                )}
                <div className="landing-card-title">
                  {card.owner}/{card.repo} #{card.number}
                  {wt?.plain?.title ? ` — ${wt.plain.title}` : ''}
                </div>
                {wt === undefined ? (
                  <div className="landing-card-desc">Loading…</div>
                ) : wt === null ? (
                  <div className="landing-card-desc landing-status unavailable">Not analysed yet</div>
                ) : (
                  <>
                    <div className="landing-card-desc">{wt.plain?.problem}</div>
                    <div className="landing-card-meta">
                      {cost && <span>{cost}</span>}
                      {dur && <span>{dur}</span>}
                      {subagents !== undefined && <span>{subagents} sub-agent{subagents === 1 ? '' : 's'}</span>}
                      {wt.shots?.by === 'bob-verifier' && <span className="landing-card-badge">screenshots by Bob</span>}
                      {wt.verification?.ablation && <span className="landing-card-badge">evidence-checked</span>}
                    </div>
                  </>
                )}
                <div className="landing-card-footer">
                  {wt === undefined ? (
                    <span className="landing-status loading">Checking…</span>
                  ) : wt ? (
                    <a className={`landing-card-link${card.primary ? ' landing-card-cta' : ''}`} href={key}>
                      Open walkthrough →
                    </a>
                  ) : null}
                  {card.hasReplay && (
                    <a className="landing-card-link landing-card-link-secondary" href={replayHref(card)}>
                      Watch the analysis →
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="landing-how" id="how-it-works">
        <h2 className="landing-examples-h">How it works</h2>
        <div className="landing-how-steps">
          {HOW_IT_WORKS.map((s) => (
            <div className="landing-how-step" key={s.n}>
              <span className="landing-how-n">{s.n}</span>
              <div className="landing-how-t">{s.t}</div>
              <div className="landing-how-d">{s.d}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
