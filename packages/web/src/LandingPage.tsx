/**
 * LandingPage — shown at "/" when no PR URL is present in the path.
 *
 * Provides:
 *  - A GitHub PR URL input that navigates to /:owner/:repo/:number
 *  - Three example cards; cards without a cached walkthrough show
 *    "not analysed yet" instead of a broken link.
 */

import { useState, useEffect } from 'react';

interface ExampleCard {
  owner: string;
  repo: string;
  number: number;
  title: string;
  description: string;
}

const EXAMPLES: ExampleCard[] = [
  {
    owner: 'excalidraw',
    repo: 'excalidraw',
    number: 10295,
    title: 'excalidraw / excalidraw #10295',
    description: 'Small fix: floating sidebar closes when the main menu opens (+19 −7)',
  },
  {
    owner: 'excalidraw',
    repo: 'excalidraw',
    number: 9403,
    title: 'excalidraw / excalidraw #9403',
    description: 'Medium fix: keep the original element in place on Alt-duplication',
  },
  {
    owner: 'excalidraw',
    repo: 'excalidraw',
    number: 8340,
    title: 'excalidraw / excalidraw #8340',
    description: 'Large refactor: new-element drawing performance (339 hunks, mostly tests)',
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
  return `/api/walkthroughs/${c.owner}/${c.repo}/${c.number}`;
}

export function LandingPage() {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [availability, setAvailability] = useState<Record<string, boolean | null>>({});

  // Probe the API for each example card on mount.
  useEffect(() => {
    for (const card of EXAMPLES) {
      const key = cardHref(card);
      fetch(apiHref(card), { method: 'HEAD' })
        .then((res) => setAvailability((prev) => ({ ...prev, [key]: res.ok })))
        .catch(() => setAvailability((prev) => ({ ...prev, [key]: false })));
    }
  }, []);

  function handleGo() {
    const parsed = parsePRUrl(input);
    if (!parsed) {
      setError('Enter a GitHub PR URL like https://github.com/owner/repo/pull/123');
      return;
    }
    setError('');
    window.location.href = `/${parsed.owner}/${parsed.repo}/${parsed.number}`;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleGo();
  }

  return (
    <div className="landing">
      <div className="landing-hero">
        <h1 className="landing-title">PR Walkthrough</h1>
        <p className="landing-sub">
          Paste a GitHub pull request URL to get a narrated, step-by-step walkthrough
          written by IBM Bob 2.0.
        </p>

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
          <button className="v2btn primary" onClick={handleGo}>
            Analyse →
          </button>
        </div>
        {error && <p className="landing-error">{error}</p>}
      </div>

      <div className="landing-examples">
        <h2 className="landing-examples-h">Example walkthroughs</h2>
        <div className="landing-cards">
          {EXAMPLES.map((card) => {
            const key = cardHref(card);
            const ready = availability[key];   // true | false | undefined (loading)
            return (
              <div className="landing-card" key={key}>
                <div className="landing-card-title">{card.title}</div>
                <div className="landing-card-desc">{card.description}</div>
                <div className="landing-card-footer">
                  {ready === undefined ? (
                    <span className="landing-status loading">Checking…</span>
                  ) : ready ? (
                    <a className="landing-card-link" href={key}>
                      Open walkthrough →
                    </a>
                  ) : (
                    <span className="landing-status unavailable">Not analysed yet</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
