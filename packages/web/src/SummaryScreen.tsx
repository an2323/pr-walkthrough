/**
 * SummaryScreen — "Done" outro: problem/fix recap, inline Before/After diagram (no screenshot).
 */

import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';
import { useState } from 'react';
import { SHOW_TRY_IT, SHOW_CHECKS } from './features';
import { useReview, targetLabel } from './review';
import { MapSvg, MapLegend } from './MapSvg';
import { edgesFor } from './MapModal';

interface Props {
  walkthrough: Walkthrough;
  plain: PlainData;
  flow: Step[];
  minors: Step[];
  checks: Record<string, boolean>;
  asks: Record<string, boolean>;
  verifiedItems: Record<number, boolean>;
  onGoToStep: (i: number) => void;
  onOpenDrawer: (stepId: string) => void;
  onOpenMap?: () => void;
  onBackToStart?: () => void;
}

export function SummaryScreen({
  walkthrough,
  plain,
  flow,
  minors,
  checks,
  asks,
  verifiedItems,
  onGoToStep,
  onOpenDrawer,
  onOpenMap,
  onBackToStart,
}: Props) {
  const withCheck = flow.filter((s) => plain.steps[s.id]?.check);
  const doneChecks = withCheck.filter((s) => checks[s.id]);
  const asked = Object.entries(asks)
    .filter(([, v]) => v)
    .map(([id]) => id);

  const comment = asked.length
    ? asked.map((id) => `- ${plain.questions?.[id] ?? (walkthrough.openQuestions.find(q => q.stepId === id)?.question ?? '')}`).join('\n')
    : '';

  const scenarios = walkthrough.verification?.scenario ?? [];
  const tried = Object.values(verifiedItems).filter(Boolean).length;

  const { status, post } = useReview();
  const [posting, setPosting] = useState(false);
  const [postedUrl, setPostedUrl] = useState<{ url: string; text: string } | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [mapMode, setMapMode] = useState<'before' | 'after'>('after');

  async function postQuestions() {
    if (!comment) return;
    setPosting(true);
    setPostError(null);
    try {
      const c = await post(`Questions from the walkthrough:\n\n${comment}`);
      setPostedUrl({ url: c.url, text: comment });
    } catch (e) {
      setPostError(String(e instanceof Error ? e.message : e));
    } finally {
      setPosting(false);
    }
  }

  function copyComment() {
    if (!comment) return;
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(comment);
    } else {
      const pre = document.getElementById('v2-comment');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }

  const prUrl = walkthrough.pr.url;
  const coverage = walkthrough.coverage;
  const hasGraph = (walkthrough.graph?.nodes?.length ?? 0) > 0;
  const mapEdges = hasGraph ? edgesFor(walkthrough, mapMode) : [];

  return (
    <div className="v2card">
      <div className="v2eyebrow"><b>Done</b></div>
      <h1 className="v2h1">{plain.title}</h1>

      <div className="outro-recap">
        <p className="v2say"><span className="outro-label">Problem</span> {plain.problem}</p>
        <p className="v2say"><span className="outro-label">Fix</span> {plain.fix}</p>
      </div>

      {hasGraph && (
        <div className="outro-map">
          <div className="outro-map-h">
            <h2>How the pieces connect</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div className="seg" role="group" aria-label="Map mode">
                {(['after', 'before'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mapMode === m}
                    onClick={() => setMapMode(m)}
                  >
                    {m === 'before' ? 'Before' : 'After'}
                  </button>
                ))}
              </div>
              {onOpenMap && (
                <button type="button" className="outro-map-link" onClick={onOpenMap}>
                  View full diagram ↗
                </button>
              )}
            </div>
          </div>
          <div className="outro-map-body">
            <MapSvg
              graph={walkthrough.graph}
              edges={mapEdges}
              allNodes={true}
              edgesPlain={plain.edges}
            />
            <MapLegend />
          </div>
        </div>
      )}

      {coverage && (
        <p className="note">
          {coverage.explained + coverage.skipped} of {coverage.totalHunks} hunks accounted for: {coverage.explained} explained, {coverage.skipped} skipped.
        </p>
      )}

      {SHOW_CHECKS && withCheck.length > 0 && (
        <div className="sum-list">
          {withCheck.map((s) => {
            const done = !!checks[s.id];
            return (
              <div className="sum-item" key={s.id}>
                <span className={`m ${done ? 'ok' : 'no'}`}>{done ? '✓' : '○'}</span>
                <button
                  className="link-btn"
                  style={{ textAlign: 'left' }}
                  onClick={() => onGoToStep(flow.indexOf(s))}
                >
                  {plain.steps[s.id]?.check}
                </button>
              </div>
            );
          })}
          {SHOW_TRY_IT && scenarios.length > 0 && (
            <div className="sum-item">
              <span className={`m ${tried === scenarios.length ? 'ok' : 'no'}`}>
                {tried === scenarios.length ? '✓' : '○'}
              </span>
              <span>Tried {tried} of {scenarios.length} scenarios in the app</span>
            </div>
          )}
          <p className="note">{doneChecks.length} of {withCheck.length} checks done</p>
        </div>
      )}

      {comment && (
        <>
          <h2 className="v2h2">Questions for the author</h2>
          <pre className="comment" id="v2-comment">{comment}</pre>
          <div className="cta">
            {status.enabled && (
              <button
                className="v2btn primary"
                disabled={posting || postedUrl?.text === comment}
                onClick={() => void postQuestions()}
              >
                {posting ? 'Posting…' : postedUrl?.text === comment ? 'Posted' : `Post to ${targetLabel(status)}`}
              </button>
            )}
            <button className={`v2btn${status.enabled ? '' : ' primary'}`} onClick={copyComment}>
              Copy as review comment
            </button>
          </div>
          {postedUrl && (
            <p className="note">
              Posted on GitHub —{' '}
              <a href={postedUrl.url} target="_blank" rel="noopener noreferrer">view the comment ↗</a>
            </p>
          )}
          {postError && <p className="note" style={{ color: 'var(--bad)' }}>{postError}</p>}
        </>
      )}

      {(minors.length > 0 || (walkthrough.skippedHunks ?? []).length > 0) && (
        <>
          <h2 className="v2h2">Also in this PR</h2>
          <div className="sum-list">
            {minors.map((s) => (
              <div className="sum-item" key={s.id}>
                <span className="m no">·</span>
                <span>
                  {plain.steps[s.id]?.head}. {plain.steps[s.id]?.say}{' '}
                  <button className="link-btn" onClick={() => onOpenDrawer(s.id)}>
                    show
                  </button>
                </span>
              </div>
            ))}
            {walkthrough.skippedHunks?.length > 0 && (() => {
              const mechanical: Record<string, number> = {};
              const analyzerSkipped: { hunkId: string; reason: string }[] = [];
              const MECH = new Set(['tests', 'snapshots', 'lockfile', 'translations', 'generated']);
              for (const s of walkthrough.skippedHunks) {
                if (MECH.has(s.reason)) mechanical[s.reason] = (mechanical[s.reason] ?? 0) + 1;
                else analyzerSkipped.push(s);
              }
              const mechLines: string[] = [];
              const tsCount = (mechanical['tests'] ?? 0) + (mechanical['snapshots'] ?? 0);
              if (tsCount > 0) mechLines.push(`${tsCount} test and snapshot hunk${tsCount !== 1 ? 's' : ''}`);
              for (const [r, label] of [['lockfile','lockfile'],['translations','translation'],['generated','generated']] as const) {
                if (mechanical[r]) mechLines.push(`${mechanical[r]} ${label} hunk${mechanical[r] !== 1 ? 's' : ''}`);
              }
              return (
                <>
                  {mechLines.map((line) => (
                    <div className="sum-item" key={line}>
                      <span className="m no">·</span>
                      <span>{line}</span>
                    </div>
                  ))}
                  {analyzerSkipped.length > 0 && (
                    <div className="sum-item">
                      <span className="m no">·</span>
                      <span>
                        {analyzerSkipped.length} small cleanup{analyzerSkipped.length !== 1 ? 's' : ''}:{' '}
                        {[...new Set(analyzerSkipped.map((h) => h.reason))].join('; ')}
                      </span>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}

      <div className="outro-links">
        {prUrl && (
          <a className="v2btn primary" href={prUrl} target="_blank" rel="noopener noreferrer">
            Open PR ↗
          </a>
        )}
        {onOpenMap && (
          <button type="button" className="v2btn" onClick={onOpenMap}>
            Diagram
          </button>
        )}
        {onBackToStart && (
          <button type="button" className="v2btn" onClick={onBackToStart}>
            ← Back to start
          </button>
        )}
      </div>
    </div>
  );
}
