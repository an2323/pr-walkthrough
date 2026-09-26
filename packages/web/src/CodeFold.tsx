/**
 * CodeFold — renders a code block with ±3 context around changed lines.
 * Lines beyond the context window fold into "⋯ N more lines" buttons that expand in place.
 * Ported from the prototype codeBlock() function.
 */

import { useState, type ReactElement } from 'react';
import type { CodeBlock, CodeLine } from '@pr-walkthrough/shared';
import { LineComposer, type PostedComment } from './review';

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
}

export function CodeFold({ block, prRepo, baseSha, headSha, prUrl }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [composing, setComposing] = useState<number | null>(null);
  const [posted, setPosted] = useState<Record<number, PostedComment[]>>({});

  const L = block.lines;
  // Reconstructed lines exist in no revision, so there is nothing on GitHub to comment on.
  const commentable = !block.reconstructed;

  const lineRow = (l: CodeLine, k: number) => {
    const canComment = commentable && l.kind !== 'elided';
    return (
      <div className={`ln ${l.kind}${composing === k ? ' on' : ''}`} key={`ln-${k}`}>
        {canComment ? (
          <button
            className="g cm"
            title="Comment on this line"
            aria-label="Comment on this line"
            onClick={() => setComposing(composing === k ? null : k)}
          >
            <span className="gl">{glyph[l.kind] ?? ''}</span>
            <span className="plus">+</span>
          </button>
        ) : (
          <span className="g">{glyph[l.kind] ?? ''}</span>
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
      out.push(
        <LineComposer
          key={`composer-${k}`}
          anchor={{ file: block.file, revision: block.revision, lines: L.map(({ kind, text }) => ({ kind, text })), index: k }}
          onCancel={() => setComposing(null)}
          onPosted={(c) => {
            setPosted((prev) => ({ ...prev, [k]: [...(prev[k] ?? []), c] }));
            setComposing(null);
          }}
        />
      );
    }
    return out;
  };
  const keep = L.map((_, i) => {
    for (let d = -CTX; d <= CTX; d++) {
      const neighbor = L[i + d];
      if (neighbor && isKey(neighbor)) return true;
    }
    return false;
  });

  const sha = block.revision === 'base' ? baseSha : headSha;
  const ghUrl = sha
    ? `https://github.com/${prRepo}/blob/${sha}/${block.file}`
    : `${prUrl}/files`;

  const filename = block.file.split('/').pop() ?? block.file;
  const nAdded = L.filter((l) => l.kind === 'added').length;
  const nRemoved = L.filter((l) => l.kind === 'removed').length;
  let diffLabel = '';
  if (nAdded || nRemoved) {
    diffLabel = `+${nAdded} −${nRemoved}`;
  } else {
    diffLabel = block.revision === 'base' ? 'before the change' : block.revision === 'head' ? 'after the change' : '';
  }

  const glyph: Record<string, string> = { added: '+', removed: '−', focus: '›' };

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
