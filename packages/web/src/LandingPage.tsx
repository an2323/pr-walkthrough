/**
 * LandingPage — shown at "/" when no PR URL is present in the path.
 *
 * Layout follows docs/prototypes/landing-variants.html board Variant2a:
 * centered hero, layered rotated Before/After shot cards, example cards,
 * how-it-works, footer. Cards show real numbers from each walkthrough JSON.
 */

import { useState, useEffect } from 'react';
import type { Walkthrough } from '@pr-walkthrough/shared';
import { STATIC, walkthroughUrl, shotUrl, apiUrl } from './staticMode';

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
    number: 10295,
    primary: true,
    hasReplay: true,
  },
  {
    owner: 'excalidraw',
    repo: 'excalidraw',
    number: 8340,
    hasReplay: true,
  },
];

/** GET /api/recent — one finished walkthrough on this server. */
interface RecentWalkthrough {
  owner: string;
  repo: string;
  number: number;
  title?: string;
  problem?: string;
  thumb?: string;
  costUsd?: number;
  updatedAt: string;
}

/** GET /api/config — what the live server allows. */
interface ServerConfig {
  liveAnalysis: boolean;
  accessCodeRequired: boolean;
  dailyLimit: number;
  usedToday: number;
}

const ACCESS_CODE_KEY = 'prw-access-code';

/** Hero stack always uses #10295's before/after shots (Variant2a demo focus). */
const HERO = { owner: 'excalidraw', repo: 'excalidraw', number: 10295 };

function parsePRUrl(raw: string): { owner: string; repo: string; number: number } | null {
  const trimmed = raw.trim().replace(/\/$/, '');
  const m = trimmed.match(
    /(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/
  );
  if (m) return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
  const s = trimmed.match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/);
  if (s) return { owner: s[1], repo: s[2], number: parseInt(s[3], 10) };
  return null;
}

function cardHref(c: { owner: string; repo: string; number: number }): string {
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
  { n: '1', t: 'Reads the PR', d: 'The diff, commit history and any file it needs.' },
  { n: '2', t: 'Checks its own story', d: 'Runs the app to see which changes the fix needs.' },
  { n: '3', t: 'Narrates it', d: 'Ordered by reasoning, evidence attached.' },
];

export function LandingPage() {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [cards, setCards] = useState<Record<string, Walkthrough | null | undefined>>({});
  const [hero, setHero] = useState<Walkthrough | null | undefined>(undefined);

  useEffect(() => {
    for (const card of EXAMPLES) {
      const key = cardHref(card);
      fetch(apiHref(card))
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then((wt: Walkthrough) => {
          setCards((prev) => ({ ...prev, [key]: wt }));
          if (card.number === HERO.number) setHero(wt);
        })
        .catch(() => {
          setCards((prev) => ({ ...prev, [key]: null }));
          if (card.number === HERO.number) setHero(null);
        });
    }
  }, []);

  // Every finished analysis on this server, newest first — a run started here can always be found again.
  const [recent, setRecent] = useState<RecentWalkthrough[]>([]);
  useEffect(() => {
    if (STATIC) return;
    fetch(apiUrl('/api/recent?limit=12'))
      .then((res) => (res.ok ? res.json() : []))
      .then((list: RecentWalkthrough[]) => {
        const shown = new Set(EXAMPLES.map(cardHref));
        setRecent(list.filter((r) => !shown.has(cardHref(r))));
      })
      .catch(() => setRecent([]));
  }, []);

  const [starting, setStarting] = useState(false);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [accessCode, setAccessCode] = useState(() => localStorage.getItem(ACCESS_CODE_KEY) ?? '');

  useEffect(() => {
    if (STATIC) return;
    fetch(apiUrl('/api/config'))
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((c: ServerConfig) => setConfig(c))
      .catch(() => setConfig(null));
  }, []);

  async function handleGo() {
    const parsed = parsePRUrl(input);
    if (!parsed) {
      setError('Enter a GitHub PR URL like https://github.com/owner/repo/pull/123');
      return;
    }
    setError('');
    const viewerPath = `/${parsed.owner}/${parsed.repo}/${parsed.number}`;
    const progressReplay = `${viewerPath}/progress?replay=1`;

    setStarting(true);

    // Prefer a recorded analysis replay when we already have the walkthrough —
    // that's the demo path: paste URL → progress screen → viewer (not a skip
    // straight into the finished walkthrough).
    try {
      const hasWalkthrough = await fetch(apiHref(parsed), { method: STATIC ? 'GET' : 'HEAD' });
      if (hasWalkthrough.ok) {
        if (STATIC) {
          // Static build only ships PRs that have a recording when hasReplay is set on cards;
          // probe the ndjson the same way ProgressScreen loads it.
          const rec = await fetch(`/data/events/${parsed.owner}/${parsed.repo}/${parsed.number}.ndjson`, { method: 'HEAD' });
          window.location.href = rec.ok ? progressReplay : viewerPath;
          return;
        }
        const rec = await fetch(apiUrl(`/api/runs/${parsed.owner}/${parsed.repo}/${parsed.number}`), { method: 'HEAD' });
        window.location.href = rec.ok ? progressReplay : viewerPath;
        return;
      }
    } catch {
      // fall through to live analyze
    }

    if (STATIC) {
      setError('This demo only opens finished walkthroughs below — live analysis needs a local/server build.');
      setStarting(false);
      return;
    }

    if (config && !config.liveAnalysis) {
      setError('Live analysis is turned off on this server — only finished walkthroughs open here.');
      setStarting(false);
      return;
    }
    if (config?.accessCodeRequired && !accessCode.trim()) {
      setError('Enter the access code to start a new analysis.');
      setStarting(false);
      return;
    }

    try {
      const res = await fetch(apiUrl('/api/analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prUrl: input.trim(),
          ...(accessCode.trim() ? { accessCode: accessCode.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        if (res.status === 401) localStorage.removeItem(ACCESS_CODE_KEY);
        setError(
          res.status === 401
            ? 'Wrong access code.'
            : body.error ?? `Could not start analysis (HTTP ${res.status})`
        );
        setStarting(false);
        return;
      }
      if (accessCode.trim()) localStorage.setItem(ACCESS_CODE_KEY, accessCode.trim());
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

  const beforeSrc = hero?.shots?.before?.src;
  const afterSrc = hero?.shots?.after?.src;

  return (
    <div className="landing landing-v2a">
      <nav className="landing-nav">
        <span className="landing-brand-row">
          <svg className="landing-logo" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
            <rect x="0.75" y="0.75" width="28.5" height="28.5" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
            <circle cx="10" cy="20" r="2.4" fill="var(--accent)" />
            <circle cx="20" cy="10" r="2.4" fill="var(--good)" />
            <path d="M10 20 L10 13 L20 13 L20 10" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="landing-brand">PR Walkthrough</span>
        </span>
        <span className="landing-nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="https://github.com/an2323/pr-walkthrough" target="_blank" rel="noopener noreferrer">
            GitHub ↗
          </a>
        </span>
      </nav>

      <div className="landing-hero landing-hero-v2a">
        <h1 className="landing-title">
          Stop reverse-engineering pull requests.<br />Get a narrated walkthrough instead.
        </h1>
        <p className="landing-sub landing-sub-centered">
          A narrated tour of a pull request — what broke, why, and how the fix lands.
        </p>

        <div className="landing-input-row landing-input-centered">
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
        {config?.liveAnalysis && config.accessCodeRequired && (
          <div className="landing-input-row landing-input-centered landing-access-row">
            <input
              className="landing-input"
              type="password"
              placeholder="Access code (new analyses only)"
              value={accessCode}
              onChange={(e) => { setAccessCode(e.target.value); setError(''); }}
              onKeyDown={handleKeyDown}
              aria-label="Access code"
              autoComplete="off"
            />
          </div>
        )}
        {error && <p className="landing-error landing-error-centered">{error}</p>}
        {STATIC && (
          <p className="landing-note landing-note-centered">
            Demo: finished walkthroughs below open here; new PRs need a local/server build.
          </p>
        )}
      </div>

      {(beforeSrc || afterSrc) && (
        <div className="landing-stack" aria-hidden={false}>
          {beforeSrc && (
            <figure className="landing-stack-card landing-stack-before">
              <span className="landing-stack-badge landing-stack-badge-bad">Before</span>
              <div className="landing-stack-frame">
                <img
                  src={shotUrl(HERO.owner, HERO.repo, HERO.number, beforeSrc)}
                  alt="Before: toolbar draws over the floating sidebar"
                />
              </div>
              <figcaption>Toolbar draws over the sidebar</figcaption>
            </figure>
          )}
          {afterSrc && (
            <figure className="landing-stack-card landing-stack-after">
              <span className="landing-stack-badge landing-stack-badge-good">After</span>
              <div className="landing-stack-frame">
                <img
                  src={shotUrl(HERO.owner, HERO.repo, HERO.number, afterSrc)}
                  alt="After: sidebar sits above the toolbar"
                />
              </div>
              <figcaption>Sidebar sits on top</figcaption>
            </figure>
          )}
        </div>
      )}

      <div className="landing-examples">
        <h2 className="landing-examples-h">Try a walkthrough</h2>
        <div className="landing-cards landing-cards-2">
          {EXAMPLES.map((card) => {
            const key = cardHref(card);
            const wt = cards[key];
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
                      {wt.shots?.by === 'bob-verifier' && <span className="landing-card-badge">screenshots from the running app</span>}
                      {wt.verification?.ablation && <span className="landing-card-badge">evidence-checked</span>}
                      {!wt.shots && <span className="landing-card-badge">no screenshots</span>}
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

      {recent.length > 0 && (
        <div className="landing-examples" id="recent">
          <h2 className="landing-examples-h">Recent analyses</h2>
          <div className="landing-cards landing-cards-2">
            {recent.map((r) => {
              const href = cardHref(r);
              const cost = fmtCost(r.costUsd);
              return (
                <div className="landing-card" key={href}>
                  {r.thumb && <img className="landing-card-thumb" src={shotUrl(r.owner, r.repo, r.number, r.thumb)} alt="" />}
                  <div className="landing-card-title">
                    {r.owner}/{r.repo} #{r.number}
                    {r.title ? ` — ${r.title}` : ''}
                  </div>
                  {r.problem && <div className="landing-card-desc">{r.problem}</div>}
                  <div className="landing-card-meta">
                    {cost && <span>{cost}</span>}
                    <span>{new Date(r.updatedAt).toLocaleString()}</span>
                  </div>
                  <div className="landing-card-footer">
                    <a className="landing-card-link" href={href}>
                      Open walkthrough →
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="landing-how" id="how-it-works">
        <h2 className="landing-examples-h">How it works</h2>
        <div className="landing-how-steps">
          {HOW_IT_WORKS.map((s) => (
            <div className="landing-how-step" key={s.n}>
              <div className="landing-how-t">{s.n} · {s.t}</div>
              <div className="landing-how-d">{s.d}</div>
            </div>
          ))}
        </div>
      </div>

      <footer className="landing-footer">
        <span>MIT licensed · Analysed with IBM Bob</span>
        <a href="https://github.com/an2323/pr-walkthrough" target="_blank" rel="noopener noreferrer">
          github.com/an2323/pr-walkthrough
        </a>
      </footer>
    </div>
  );
}
