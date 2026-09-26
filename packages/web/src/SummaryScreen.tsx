/**
 * SummaryScreen — final screen with check list, asked questions, minor steps, skipped hunks.
 */

import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';

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

  function copyComment() {
    if (!comment) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(comment);
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

  return (
    <div className="v2card">
      <div className="v2eyebrow"><b>Your review</b></div>
      <h1 className="v2h1">
        {withCheck.every((s) => checks[s.id]) && withCheck.length > 0
          ? 'All checks done'
          : `${doneChecks.length} of ${withCheck.length} checks done`}
      </h1>

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
        {scenarios.length > 0 && (
          <div className="sum-item">
            <span className={`m ${tried === scenarios.length ? 'ok' : 'no'}`}>
              {tried === scenarios.length ? '✓' : '○'}
            </span>
            <span>Tried {tried} of {scenarios.length} scenarios in the app</span>
          </div>
        )}
      </div>

      <h2 className="v2h2">Questions for the author</h2>
      {comment ? (
        <>
          <pre className="comment" id="v2-comment">{comment}</pre>
          <div className="cta">
            <button className="v2btn primary" onClick={copyComment}>
              Copy as review comment
            </button>
          </div>
        </>
      ) : (
        <p className="note">
          None added.{' '}
          {Object.keys(plain.questions ?? {}).length > 0 &&
            `The analysis suggested ${Object.keys(plain.questions!).length}; add them with "Add to review" on the steps.`}
        </p>
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

      {minors.length === 0 && (walkthrough.skippedHunks ?? []).length === 0 && (
        <p className="note">Nothing else.</p>
      )}

      <p className="note">
        All {walkthrough.coverage?.totalHunks ?? walkthrough.hunks.length} changes in the diff are covered by the steps above.
      </p>
    </div>
  );
}
