/**
 * LandingPage — shown at "/" when no PR URL is present in the path.
 *
 * Top to bottom: what the product is (a real step of a real walkthrough), a place to paste a PR — with a live
 * line saying what you will get before you press the button — the proof that Bob runs the PR before and after,
 * and the walkthroughs that are already finished (open instantly). Copy lives here; the facts it states come
 * from the server (/api/preview, /api/recent, /api/config) or from landingData.ts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Walkthrough } from '@pr-walkthrough/shared';
import { STATIC, walkthroughUrl, shotUrl, apiUrl } from './staticMode';
import { parsePRUrl } from './prUrl';
import { EXCALIDRAW_UI_FIXES_URL, SUGGESTED_PRS } from './landingData';
import './Landing.css';

/** GET /api/preview — mirrors PrPreview in the server. */
interface PrPreview {
  owner: string;
  repo: string;
  number: number;
  analysed: boolean;
  title?: string;
  additions?: number;
  deletions?: number;
  files?: number;
  screenshots: { available: boolean; reason?: string };
  tooBig?: string;
}

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
  dailyLimit: number;
  usedToday: number;
}

interface CardData {
  owner: string;
  repo: string;
  number: number;
  title: string;
  problem?: string;
  thumb?: string;
  costUsd?: number;
  analysedAt?: string;
  hasReplay: boolean;
  screenshots: boolean;
}

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'notPr' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; preview: PrPreview };

/** Static demo build: no API, so the finished walkthroughs are the files it ships. */
const STATIC_EXAMPLES = [
  { owner: 'excalidraw', repo: 'excalidraw', number: 10295 },
  { owner: 'excalidraw', repo: 'excalidraw', number: 8340 },
];

const viewerPath = (c: { owner: string; repo: string; number: number }) => `/${c.owner}/${c.repo}/${c.number}`;

function fmtDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function useCards(): CardData[] | null {
  const [cards, setCards] = useState<CardData[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const done = (list: CardData[]) => { if (!cancelled) setCards(list); };

    if (STATIC) {
      Promise.all(
        STATIC_EXAMPLES.map((c) =>
          fetch(walkthroughUrl(c.owner, c.repo, c.number))
            .then((r) => (r.ok ? (r.json() as Promise<Walkthrough>) : null))
            .then((wt): CardData | null =>
              wt
                ? {
                    ...c,
                    title: wt.plain?.title ?? wt.pr.title,
                    ...(wt.plain?.problem ? { problem: wt.plain.problem } : {}),
                    ...(wt.shots?.before ? { thumb: wt.shots.before.src } : {}),
                    ...(wt.meta.run?.costUsd !== undefined ? { costUsd: wt.meta.run.costUsd } : {}),
                    hasReplay: true,
                    screenshots: !!wt.shots,
                  }
                : null
            )
            .catch(() => null)
        )
      ).then((list) => done(list.filter((c): c is CardData => c !== null)));
      return () => { cancelled = true; };
    }

    fetch(apiUrl('/api/recent?limit=9'))
      .then((r) => (r.ok ? (r.json() as Promise<RecentWalkthrough[]>) : []))
      .then(async (list) => {
        // "Watch the run" only where a recording exists; one cheap probe per card.
        const replay = await Promise.all(
          list.map((r) => fetch(apiUrl(`/api/runs/${r.owner}/${r.repo}/${r.number}`), { method: 'HEAD' }).then((x) => x.ok).catch(() => false))
        );
        done(
          list.map((r, i): CardData => ({
            owner: r.owner,
            repo: r.repo,
            number: r.number,
            title: r.title ?? `${r.owner}/${r.repo} #${r.number}`,
            ...(r.problem ? { problem: r.problem } : {}),
            ...(r.thumb ? { thumb: r.thumb } : {}),
            ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
            analysedAt: r.updatedAt,
            hasReplay: replay[i] ?? false,
            screenshots: !!r.thumb,
          }))
        );
      })
      .catch(() => done([]));
    return () => { cancelled = true; };
  }, []);
  return cards;
}

export function LandingPage() {
  const cards = useCards();
  return (
    <div className="lp">
      <nav className="lp-nav">
        <span className="lp-brand">
          <svg width="28" height="28" viewBox="0 0 30 30" aria-hidden="true">
            <rect x="0.75" y="0.75" width="28.5" height="28.5" rx="7" fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="1.5" />
            <circle cx="10" cy="20" r="2.4" fill="var(--accent)" />
            <circle cx="20" cy="10" r="2.4" fill="var(--good)" />
            <path d="M10 20 L10 13 L20 13 L20 10" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          PR Walkthrough
        </span>
        <span className="lp-nav-links">
          {!STATIC && <a href="#demo">Watch the demo</a>}
          <a href="#try">Try it</a>
          <a href="#analysed">Already analysed</a>
          <a href="https://github.com/an2323/pr-walkthrough" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
        </span>
      </nav>

      <header className="lp-hero">
        <h1>Stop reverse-engineering pull requests.<br />Get a narrated walkthrough instead.</h1>
        <p className="lp-sub">
          Bob reads the whole repo and explains the PR step by step — what broke, why, and whether the fix holds.{' '}
          <b>When the app can run, he runs it before and after and shows the difference.</b>
        </p>
        <DemoVideo />
      </header>

      <section className="lp-try" id="try" aria-labelledby="lp-try-h">
        <h2 id="lp-try-h">Try it on a PR</h2>
        <TryIntro />
        <PrInput />
      </section>

      <Analysed cards={cards} />

      <p className="lp-numbers">
        <span><b>15–25 min</b> per new PR</span>
        <span><b>about $2–5</b> each</span>
      </p>

      <footer className="lp-footer">
        <span>MIT licensed · Analysed with IBM Bob</span>
        <a href="https://github.com/an2323/pr-walkthrough" target="_blank" rel="noopener noreferrer">github.com/an2323/pr-walkthrough</a>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The input, with a live line saying what you will get.
// ---------------------------------------------------------------------------------------------

function PrInput() {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [pv, setPv] = useState<PreviewState>({ kind: 'idle' });
  const seq = useRef(0);

  useEffect(() => {
    if (STATIC) return;
    fetch(apiUrl('/api/config'))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((c: ServerConfig) => setConfig(c))
      .catch(() => setConfig(null));
  }, []);

  // Look the PR up as soon as the field holds something that looks like one (debounced; newest answer wins).
  useEffect(() => {
    if (STATIC) return;
    const raw = input.trim();
    if (!raw) { setPv({ kind: 'idle' }); return; }
    const mine = ++seq.current;
    if (!parsePRUrl(raw)) {
      const id = setTimeout(() => { if (mine === seq.current) setPv({ kind: 'notPr' }); }, 700);
      return () => clearTimeout(id);
    }
    setPv({ kind: 'loading' });
    const id = setTimeout(() => {
      fetch(apiUrl(`/api/preview?pr=${encodeURIComponent(raw)}`))
        .then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (mine !== seq.current) return;
          if (r.ok) setPv({ kind: 'ready', preview: body as PrPreview });
          else setPv({ kind: 'error', message: (body as { error?: string }).error ?? "Couldn't look that up just now" });
        })
        .catch(() => { if (mine === seq.current) setPv({ kind: 'error', message: "Couldn't look that up just now" }); });
    }, 350);
    return () => clearTimeout(id);
  }, [input]);

  const preview = pv.kind === 'ready' ? pv.preview : null;
  const analysed = !!preview?.analysed;
  const blocked = !!preview?.tooBig;

  async function handleGo() {
    const parsed = parsePRUrl(input);
    if (!parsed) {
      setError('Enter a GitHub PR URL like https://github.com/owner/repo/pull/123');
      return;
    }
    setError('');
    setStarting(true);

    // A finished walkthrough opens at once — no analysis, no code needed.
    try {
      const has = await fetch(walkthroughUrl(parsed.owner, parsed.repo, parsed.number), { method: STATIC ? 'GET' : 'HEAD' });
      if (has.ok) {
        window.location.href = viewerPath(parsed);
        return;
      }
    } catch {
      // fall through to a new analysis
    }

    if (STATIC) {
      setError('This demo only opens finished walkthroughs below — new analysis needs a local/server build.');
      setStarting(false);
      return;
    }
    if (config && !config.liveAnalysis) {
      setError('New analysis is turned off on this server — only finished walkthroughs open here.');
      setStarting(false);
      return;
    }
    if (blocked) {
      setError(preview!.tooBig!);
      setStarting(false);
      return;
    }
    try {
      const res = await fetch(apiUrl('/api/analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prUrl: input.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setError(body.error ?? `Could not start the analysis (HTTP ${res.status})`);
        setStarting(false);
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      window.location.href = `${viewerPath(parsed)}/progress?job=${jobId}`;
    } catch {
      setError('Could not reach the server to start the analysis.');
      setStarting(false);
    }
  }

  const go = () => void handleGo();

  return (
    <div className="lp-input-block">
      <div className="lp-input-row">
        <input
          className="lp-input"
          type="text"
          placeholder="https://github.com/owner/repo/pull/123"
          value={input}
          onChange={(e) => { setInput(e.target.value); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
          aria-label="GitHub PR URL"
          autoComplete="off"
        />
        <button className={`v2btn primary${analysed ? ' lp-go--open' : ''}`} onClick={go} disabled={starting || blocked}>
          {starting ? 'Starting…' : analysed ? 'Open now →' : 'Analyse →'}
        </button>
      </div>
      {error && <p className="lp-error" role="alert">{error}</p>}
      {pv.kind === 'idle' && !STATIC && (
        <p className="lp-micro">New analysis: about 15–25 minutes. Already analysed PRs open instantly.</p>
      )}
      {STATIC && <p className="lp-micro">Demo: finished walkthroughs below open here; new PRs need a local/server build.</p>}
      <PreviewLine pv={pv} />
      {!STATIC && <Suggested onPick={(u) => setInput(u)} />}
    </div>
  );
}

function PreviewLine({ pv }: { pv: PreviewState }) {
  if (pv.kind === 'idle') return null;
  if (pv.kind === 'loading') return <div className="lp-pv" aria-live="polite"><span className="lp-pv-quiet">Looking that up…</span></div>;
  if (pv.kind === 'notPr') {
    return (
      <div className="lp-pv lp-pv--bad" aria-live="polite">
        <b>That doesn't look like a pull request link</b>
        <span>Paste something like github.com/owner/repo/pull/123.</span>
      </div>
    );
  }
  if (pv.kind === 'error') return <div className="lp-pv lp-pv--bad" aria-live="polite"><b>{pv.message}</b></div>;
  const p = pv.preview;
  if (p.analysed) {
    return (
      <div className="lp-pv lp-pv--done" aria-live="polite">
        <b>{p.title ?? `${p.owner}/${p.repo} #${p.number}`}</b>
        <span className="lp-pv-acc">⚡ Already analysed — opens instantly, free</span>
      </div>
    );
  }
  if (p.tooBig) {
    return (
      <div className="lp-pv lp-pv--bad" aria-live="polite">
        <b>{p.title}</b>
        <span>{p.tooBig}</span>
      </div>
    );
  }
  const size = p.additions !== undefined && p.deletions !== undefined ? `+${p.additions} −${p.deletions}` : null;
  return (
    <div className={`lp-pv ${p.screenshots.available ? 'lp-pv--ok' : 'lp-pv--part'}`} aria-live="polite">
      <b>{p.title ?? `${p.owner}/${p.repo} #${p.number}`}</b>
      <span className="lp-pv-line">
        {size && <span>{size}{p.files !== undefined && ` · ${p.files} file${p.files === 1 ? '' : 's'}`}</span>}
        {p.screenshots.available ? (
          <span className="lp-pv-good">✓ Screenshots: yes — we can start this app</span>
        ) : (
          <span className="lp-pv-warn">○ Walkthrough only — {p.screenshots.reason ?? "screenshots aren't set up for this repository."}</span>
        )}
        <span>15–25 min · about $2–5</span>
      </span>
    </div>
  );
}

function TryIntro() {
  return (
    <p className="lp-try-lead">
      Paste a public GitHub PR. Best: a <b>UI-bug fix in Excalidraw</b> — Bob runs it before and after and you get screenshots.{' '}
      <a href={EXCALIDRAW_UI_FIXES_URL} target="_blank" rel="noopener noreferrer">Browse UI-fix PRs ↗</a>
      {' · '}
      <a href="#analysed">or open one that is already analysed ↓</a>
    </p>
  );
}

/** PRs that have NOT been analysed yet: choosing one fills the field and starts a new run (15–25 min). */
function Suggested({ onPick }: { onPick: (url: string) => void }) {
  return (
    <div className="lp-suggest">
      {SUGGESTED_PRS.length > 0 && (
        <>
          <p className="lp-suggest-h">Suggested for a new analysis <span>(about 15–25 minutes)</span></p>
          <div className="lp-picks">
            {SUGGESTED_PRS.map((p) => (
              <button key={p.url} type="button" className="lp-pick" onClick={() => onPick(p.url)}>
                <i>●</i>{p.label}<small>{p.size}</small>
              </button>
            ))}
          </div>
        </>
      )}
      <p className="lp-helper-quiet">
        Any other public PR works too — you get the narrated walkthrough, without screenshots (for now they need an app we have set up).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The demo: a PR pasted, analysed and explained — recorded from these very screens (docs/video/README.md).
// The file lives in public/, which the static demo build skips, so it is not offered there.
// ---------------------------------------------------------------------------------------------

function DemoVideo() {
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  if (STATIC || failed) return null;
  return (
    <div className="lp-demo" id="demo">
      <video
        ref={ref}
        className="lp-video"
        controls
        preload="metadata"
        playsInline
        poster="/demo/pr-walkthrough-demo-poster.jpg"
        aria-label="One-minute demo: a PR pasted, analysed and explained"
        onPlay={() => setStarted(true)}
        onError={() => setFailed(true)}
      >
        <source src="/demo/pr-walkthrough-demo.mp4" type="video/mp4" onError={() => setFailed(true)} />
      </video>
      {!started && (
        <button type="button" className="lp-play" onClick={() => void ref.current?.play()} aria-label="Play the one-minute demo">
          <span className="lp-play-disc" aria-hidden="true">▶</span>
          <span className="lp-play-label">Watch the demo · 1 min</span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Already analysed: every finished walkthrough on this server, newest first.
// ---------------------------------------------------------------------------------------------

function Analysed({ cards }: { cards: CardData[] | null }) {
  const list = useMemo(() => cards ?? [], [cards]);
  if (cards !== null && list.length === 0) return null;
  return (
    <section className="lp-analysed" id="analysed">
      <div className="lp-analysed-head">
        <h2>Already analysed</h2>
        <span className="lp-badge">⚡ opens instantly · no waiting</span>
      </div>
      <p className="lp-analysed-lead">Skip the wait. Open a finished one — newest first, including runs by other visitors.</p>
      {cards === null ? (
        <p className="lp-quiet">Loading…</p>
      ) : (
        <div className="lp-cards">
          {list.map((c) => {
            const date = fmtDate(c.analysedAt);
            return (
              <article className="lp-card" key={`${c.owner}/${c.repo}/${c.number}`}>
                {c.thumb && (
                  <a className="lp-card-thumb" href={viewerPath(c)} tabIndex={-1} aria-hidden="true">
                    <img src={shotUrl(c.owner, c.repo, c.number, c.thumb)} alt="" loading="lazy" />
                  </a>
                )}
                <h3><a href={viewerPath(c)}>{c.title}</a></h3>
                <p className="lp-card-ref">{c.owner}/{c.repo} #{c.number}</p>
                {c.problem && <p className="lp-card-problem">{c.problem}</p>}
                <div className="lp-card-meta">
                  {c.screenshots && <span className="lp-badge">screenshots</span>}
                  {c.costUsd !== undefined && <span className="lp-badge">${c.costUsd.toFixed(2)}</span>}
                  {date && <span className="lp-card-date">analysed {date}</span>}
                </div>
                <div className="lp-card-links">
                  <a href={viewerPath(c)}>Open walkthrough →</a>
                  {c.hasReplay && <a className="lp-quiet-link" href={`${viewerPath(c)}/progress?replay=1`}>Watch the run</a>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
