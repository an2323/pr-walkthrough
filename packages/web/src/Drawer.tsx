/**
 * Drawer — "How the analysis got here"
 * Slides in from the right, contains beats with code and annotations.
 */

import type { Walkthrough, Step, OpenQuestion } from '@pr-walkthrough/shared';
import { CodeFold } from './CodeFold';

interface Props {
  step: Step;
  walkthrough: Walkthrough;
  question?: OpenQuestion;
  onClose: () => void;
}

function md(s: string) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>');
}

const BEAT_LABELS: Record<string, string> = {
  current: 'How it works now',
  problem: 'What breaks',
  change: 'What changes',
};

export function Drawer({ step, walkthrough, question, onClose }: Props) {
  const pr = walkthrough.pr;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Analysis details">
        <div className="drawer-h">
          <h3
            dangerouslySetInnerHTML={{ __html: md(step.title) }}
          />
          <button className="x-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="drawer-b">
          {step.beats.map((beat, bi) => (
            <div key={bi}>
              <h4>{BEAT_LABELS[beat.kind] ?? beat.kind}</h4>
              <p dangerouslySetInnerHTML={{ __html: md(beat.text) }} />
              {beat.code?.map((block, ci) => (
                <div className="visual" key={ci} style={{ marginBottom: 8 }}>
                  <CodeFold
                    block={block}
                    prRepo={pr.repo}
                    baseSha={pr.baseSha}
                    headSha={pr.headSha}
                    prUrl={pr.url}
                  />
                </div>
              ))}
              {beat.traces && beat.traces.map((trace, ti) => (
                <div key={ti} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '4px 0' }}>
                  {trace.map((ts, si) => (
                    <span key={si} style={{
                      display: 'inline-block',
                      padding: '2px 8px',
                      borderRadius: 6,
                      fontSize: 13,
                      background: ts.status === 'ok' ? 'var(--good-soft)' : ts.status === 'bad' ? 'var(--bad-soft)' : 'var(--raised)',
                      color: ts.status === 'ok' ? 'var(--good)' : ts.status === 'bad' ? 'var(--bad)' : 'var(--muted)',
                      border: '1px solid var(--line)',
                    }}>
                      {ts.label}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ))}

          {question && (
            <div>
              <h4>Question (full)</h4>
              <p dangerouslySetInnerHTML={{ __html: md(question.question) }} />
              <p className="note" dangerouslySetInnerHTML={{ __html: md(question.why) }} />
            </div>
          )}

          {step.notes && step.notes.length > 0 && (
            <div>
              <h4>Notes</h4>
              {step.notes.map((n, i) => (
                <p key={i} dangerouslySetInnerHTML={{ __html: md(n) }} />
              ))}
            </div>
          )}

          <div>
            <h4>Sources</h4>
            {step.sources.map((s, i) => (
              <p key={i} className="note">
                {s.type.replace(/_/g, ' ')}: <span dangerouslySetInnerHTML={{ __html: md(s.ref) }} />
              </p>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
