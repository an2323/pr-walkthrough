/**
 * CodeFold — renders a code block with ±3 context around changed lines.
 * Lines beyond the context window fold into "⋯ N more lines" buttons that expand in place.
 * Ported from the prototype codeBlock() function.
 */

import { useEffect, useState, type ReactElement } from 'react';
import type { CodeBlock, CodeLine } from '@pr-walkthrough/shared';
import { LineComposer, type AskResult, type PostedComment } from './review';

const CTX = 3;

function esc(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isKey(l: CodeLine): boolean {
  return l.kind !== 'context' || /^\s*\/\//.test(l.text);
}

interface Props {
  block: CodeBlock;
  prRepo: string;
  baseSha?: string;
  headSha?: string;
  prUrl: string;
  /** Open the line composer on this line, prefilled (Ask flow). */
  askSeed?: { lineIndex: number; text: string } | null;
  onAskSettled?: (result: AskResult) => void;
  onAskCancel?: () => void;
}

export function CodeFold({
  block,
  prRepo,
  baseSha,
  headSha,
  prUrl,
  askSeed = null,
  onAskSettled,
  onAskCancel,
}: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [composing, setComposing] = useState<number | null>(null);
  const [composeInitial, setComposeInitial] = useState<string>('');
  const [askCompose, setAskCompose] = useState(false);
  const [posted, setPosted] = useState<Record<number, PostedComment[]>>({});

  const L = block.lines;
  // Reconstructed lines exist in no revision, so there is nothing on GitHub to comment on.
  const commentable = !block.reconstructed;

  const keep = L.map((_, i) => {
    for (let d = -CTX; d <= CTX; d++) {
      const neighbor = L[i + d];
      if (neighbor && isKey(neighbor)) return true;
    }
    return false;
  });

  useEffect(() => {
    if (!askSeed) return;
    const idx = askSeed.lineIndex;
    if (idx < 0 || idx >= L.length) return;

    let i = 0;
    while (i < L.length) {
      if (keep[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < L.length && !keep[j]) j++;
      if (idx >= i && idx < j) {
        const gapKey = `gap-${i}-${j}`;
        setExpanded((prev) => (prev[gapKey] ? prev : { ...prev, [gapKey]: true }));
        break;
      }
      i = j;
    }

    setComposing(idx);
    setComposeInitial(askSeed.text);
    setAskCompose(true);

    const t = window.setTimeout(() => {
      document.querySelector('.v2code .ln.on')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    return () => window.clearTimeout(t);
    // Only re-run when the seeded line/text changes — not when parent rebuilds the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askSeed?.lineIndex, askSeed?.text]);

  const closeComposer = () => {
    setComposing(null);
    setComposeInitial('');
    if (askCompose) {
      setAskCompose(false);
      onAskCancel?.();
    }
  };

  const lineRow = (l: CodeLine, k: number) => {
    const canComment = commentable && l.kind !== 'elided';
    // Row tint follows `change` (a diff fact) — `focus` (the analyzer's own "look
    // here" judgement) is layered on as a left accent bar instead of overriding
    // that colour, so a genuinely-changed line the analyzer only marked `focus`
    // still reads as changed (see CodeFold.tsx's glyphFor/glyphClassFor above).
    const rowClass = [
      isAdded(l) ? 'ln-added' : isRemoved(l) ? 'ln-removed' : l.kind === 'context' ? 'ln-context' : '',
      l.kind === 'focus' ? 'ln-focus' : '',
      l.kind === 'elided' ? 'ln-elided' : '',
    ].filter(Boolean).join(' ');
    return (
      <div className={`ln ${rowClass}${composing === k ? ' on' : ''}`} key={`ln-${k}`}>
        <span className="lno">{l.n ?? ''}</span>
        {canComment ? (
          <button
            className="g cm"
            title="Comment on this line"
            aria-label="Comment on this line"
            onClick={() => {
              if (composing === k) {
                closeComposer();
                return;
              }
              if (askCompose) {
                setAskCompose(false);
                onAskCancel?.();
              }
              setComposeInitial('');
              setComposing(k);
            }}
          >
            <span className={`gl ${glyphClassFor(l)}`}>{glyphFor(l)}</span>
            <span className="plus">+</span>
          </button>
        ) : (
          <span className={`g ${glyphClassFor(l)}`}>{glyphFor(l)}</span>
        )}
        <span className="t" dangerouslySetInnerHTML={{ __html: esc(l.text) }} />
      </div>
    );
  };

  const afterLine = (k: number): ReactElement[] => {
    const out: ReactElement[] = [];
    for (const [n, c] of (posted[k] ?? []).entries()) {
      out.push(
        <div className="posted" key={`posted-${k}-${n}`}>
          ↳ {c.kind === 'line' ? 'Commented on this line' : 'Posted as a PR comment'} on GitHub{' '}
          <a href={c.url} target="_blank" rel="noopener noreferrer">view ↗</a>
        </div>
      );
    }
    if (composing === k) {
      const fromAsk = askCompose;
      out.push(
        <LineComposer
          key={`composer-${k}`}
          initialText={composeInitial}
          anchor={{ file: block.file, revision: block.revision, lines: L.map(({ kind, text }) => ({ kind, text })), index: k }}
          onCancel={closeComposer}
          onCopied={fromAsk
            ? (body) => {
                setComposing(null);
                setComposeInitial('');
                setAskCompose(false);
                onAskSettled?.({ kind: 'copied', text: body, file: block.file });
              }
            : undefined}
          onPosted={(c, body) => {
            setPosted((prev) => ({ ...prev, [k]: [...(prev[k] ?? []), c] }));
            setComposing(null);
            setComposeInitial('');
            if (fromAsk) {
              setAskCompose(false);
              onAskSettled?.({
                kind: 'posted',
                url: c.url,
                text: body,
                file: block.file,
                lineKind: c.kind,
              });
            }
          }}
        />
      );
    }
    return out;
  };

  // Backend-computed from the diff (validation/line-numbers.ts) — independent of
  // the analyzer's own `kind`, which is a "look here" judgement, not a reliable
  // record of what the PR changed (a real run marked genuinely-changed lines
  // `focus` and never marked one true `removed`). Falls back to `kind` for
  // blocks generated before that backfill (reconstructed, or older cached data).
  const hasChangeData = L.some((l) => l.change !== undefined);
  const isAdded = (l: CodeLine) => (hasChangeData ? l.change === 'added' : l.kind === 'added');
  const isRemoved = (l: CodeLine) => (hasChangeData ? l.change === 'removed' : l.kind === 'removed');

  const firstLineNumber = L.find((l) => l.kind === 'focus' && l.n !== undefined)?.n ?? L.find((l) => l.n !== undefined)?.n;
  const sha = block.revision === 'base' ? baseSha : headSha;
  const ghUrl = sha
    ? `https://github.com/${prRepo}/blob/${sha}/${block.file}${firstLineNumber ? `#L${firstLineNumber}` : ''}`
    : `${prUrl}/files`;

  const filename = block.file.split('/').pop() ?? block.file;
  const nAdded = L.filter(isAdded).length;
  const nRemoved = L.filter(isRemoved).length;
  let diffLabel = '';
  if (nAdded || nRemoved) {
    diffLabel = `+${nAdded} −${nRemoved}`;
  } else {
    diffLabel = block.revision === 'base' ? 'before the change' : block.revision === 'head' ? 'after the change' : '';
  }

  const glyphFor = (l: CodeLine): string => {
    if (isAdded(l)) return '+';
    if (isRemoved(l)) return '−';
    if (l.kind === 'focus') return '›';
    return '';
  };
  const glyphClassFor = (l: CodeLine): string => {
    if (isAdded(l)) return 'g-add';
    if (isRemoved(l)) return 'g-del';
    if (l.kind === 'focus') return 'g-focus';
    return '';
  };

  // Build the rows: either lines or fold buttons
  const rows: ReactElement[] = [];
  let i = 0;
  while (i < L.length) {
    if (keep[i]) {
      const l = L[i];
      rows.push(lineRow(l, i));
      if (l.annotation) {
        rows.push(
          <div className="ann" key={`ann-${i}`}>
            {l.annotation}
          </div>
        );
      }
      rows.push(...afterLine(i));
      i++;
    } else {
      let j = i;
      while (j < L.length && !keep[j]) j++;
      const gapKey = `gap-${i}-${j}`;
      const count = j - i;
      if (expanded[gapKey]) {
        for (let k = i; k < j; k++) {
          rows.push(lineRow(L[k], k));
          rows.push(...afterLine(k));
        }
      } else {
        rows.push(
          <button
            className="fold"
            key={gapKey}
            onClick={() => setExpanded((prev) => ({ ...prev, [gapKey]: true }))}
          >
            ⋯ {count} more line{count > 1 ? 's' : ''}
          </button>
        );
      }
      i = j;
    }
  }

  return (
    <div>
      <div className="code-h">
        <span title={block.file}>{filename}</span>
        <span>
          {diffLabel && <>{diffLabel} · </>}
          <a href={ghUrl} target="_blank" rel="noopener noreferrer">
            open file ↗
          </a>
        </span>
      </div>
      <div className="v2code">{rows}</div>
    </div>
  );
}
