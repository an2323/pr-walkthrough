/**
 * review.tsx — posting reviewer comments to GitHub through the backend (ST6d).
 *
 * The backend decides whether posting is possible (write token set, demo PR on the same
 * head SHA). When it isn't, every "Post" falls back to copy-to-clipboard.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CodeBlock } from '@pr-walkthrough/shared';
import { STATIC } from './staticMode';

export type ReviewStatus =
  | { enabled: false; reason?: string }
  | { enabled: true; target: { repo: string; number: number; url: string } };

export interface CommentAnchor {
  file: string;
  revision: CodeBlock['revision'];
  lines: { kind: string; text: string }[];
  index: number;
}

export interface PostedComment {
  url: string;
  kind: 'line' | 'general';
  line?: number;
}

interface ReviewApi {
  status: ReviewStatus;
  post: (body: string, anchor?: CommentAnchor) => Promise<PostedComment>;
}

const ReviewContext = createContext<ReviewApi>({
  status: { enabled: false },
  post: () => Promise.reject(new Error('Posting is off')),
});

export function ReviewProvider({ repo, number, children }: { repo: string; number: number; children: ReactNode }) {
  const [status, setStatus] = useState<ReviewStatus>({ enabled: false });
  const base = `/api/review/${repo}/${number}`;

  useEffect(() => {
    if (STATIC) return;
    let alive = true;
    fetch(base)
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((s: ReviewStatus) => { if (alive) setStatus(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, [base]);

  const post = async (body: string, anchor?: CommentAnchor): Promise<PostedComment> => {
    const r = await fetch(`${base}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, anchor }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    return data as PostedComment;
  };

  return <ReviewContext.Provider value={{ status, post }}>{children}</ReviewContext.Provider>;
}

export function useReview(): ReviewApi {
  return useContext(ReviewContext);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function targetLabel(status: ReviewStatus): string {
  return status.enabled ? `${status.target.repo}#${status.target.number}` : '';
}

/** Inline composer shown under a code line. */
export function LineComposer({
  anchor,
  onPosted,
  onCancel,
}: {
  anchor: CommentAnchor;
  onPosted: (c: PostedComment) => void;
  onCancel: () => void;
}) {
  const { status, post } = useReview();
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'posting' | 'copied'>('idle');
  const [error, setError] = useState<string | null>(null);

  const quoted = `\`${anchor.file}\`\n> ${anchor.lines[anchor.index].text.trim()}\n\n${text.trim()}`;

  async function submit() {
    if (!text.trim()) return;
    setError(null);
    if (!status.enabled) {
      setState((await copyText(quoted)) ? 'copied' : 'idle');
      return;
    }
    setState('posting');
    try {
      onPosted(await post(text.trim(), anchor));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setState('idle');
    }
  }

  return (
    <div className="composer">
      <textarea
        autoFocus
        rows={3}
        placeholder="Comment on this line…"
        value={text}
        onChange={(e) => { setText(e.target.value); if (state === 'copied') setState('idle'); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        }}
      />
      {error && <div className="composer-err">{error}</div>}
      <div className="composer-row">
        <button className="v2btn primary sm" disabled={!text.trim() || state === 'posting'} onClick={() => void submit()}>
          {status.enabled
            ? state === 'posting' ? 'Posting…' : `Post to ${targetLabel(status)}`
            : state === 'copied' ? 'Copied' : 'Copy comment'}
        </button>
        <button className="v2btn sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
