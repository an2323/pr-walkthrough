/**
 * CodeFold — renders a code block with ±3 context around changed lines.
 * Lines beyond the context window fold into "⋯ N more lines" buttons that expand in place.
 * Ported from the prototype codeBlock() function.
 */

import { useState, type ReactElement } from 'react';
import type { CodeBlock, CodeLine } from '@pr-walkthrough/shared';

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

  const L = block.lines;
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
      const key = `ln-${i}`;
      rows.push(
        <div className={`ln ${l.kind}`} key={key}>
          <span className="g">{glyph[l.kind] ?? ''}</span>
          <span
            className="t"
            dangerouslySetInnerHTML={{ __html: esc(l.text) }}
          />
        </div>
      );
      if (l.annotation) {
        rows.push(
          <div className="ann" key={`ann-${i}`}>
            {l.annotation}
          </div>
        );
      }
      i++;
    } else {
      let j = i;
      while (j < L.length && !keep[j]) j++;
      const gapKey = `gap-${i}-${j}`;
      const count = j - i;
      if (expanded[gapKey]) {
        for (let k = i; k < j; k++) {
          const l = L[k];
          rows.push(
            <div className={`ln ${l.kind}`} key={`ln-${k}`}>
              <span className="g">{glyph[l.kind] ?? ''}</span>
              <span className="t" dangerouslySetInnerHTML={{ __html: esc(l.text) }} />
            </div>
          );
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
