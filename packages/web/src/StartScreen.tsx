/**
 * StartScreen — PR summary, stats, Start / Listen. Map moved to on-demand modal (ST6g).
 */

import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';

interface Props {
  walkthrough: Walkthrough;
  plain: PlainData;
  flow: Step[];
  onStart: () => void;
  onListenAll: () => void;
  onOpenMap?: () => void;
}

export function StartScreen({ walkthrough, plain, flow, onStart, onListenAll, onOpenMap }: Props) {
  const pr = walkthrough.pr;

  const checks = flow.filter((s) => plain.steps[s.id]?.check).length;
  const wordCount = walkthrough.steps.reduce(
    (a, s) => a + s.narration.split(/\s+/).length,
    0
  );
  const minutes = Math.max(1, Math.round(wordCount / 150));
  const totalHunks = walkthrough.coverage?.totalHunks ?? walkthrough.hunks.length;
  const explained = walkthrough.coverage?.explained ?? 0;
  const skipped = walkthrough.coverage?.skipped ?? 0;

  return (
    <div className="v2card">
      <div className="v2eyebrow">Pull request walkthrough</div>
      <h1 className="v2h1">{plain.title}</h1>

      <div className="pf">
        <section className="p">
          <h3>Problem</h3>
          <p>{plain.problem}</p>
        </section>
        <section className="f">
          <h3>Fix</h3>
          <p>{plain.fix}</p>
        </section>
      </div>

      <div className="hero-stats">
        <div className="stat">
          <b>{flow.length}</b>
          <span>short steps</span>
        </div>
        <div className="stat">
          <b>{checks}</b>
          <span>things to check</span>
        </div>
        <div className="stat">
          <b>~{minutes} min</b>
          <span>to listen</span>
        </div>
        <div className="stat">
          <b>{explained + skipped}/{totalHunks}</b>
          <span>diff hunks covered</span>
        </div>
      </div>

      <div className="cta">
        <button className="v2btn primary" onClick={onStart}>
          Start →
        </button>
        <button className="v2btn" onClick={onListenAll}>
          ▶ Listen instead
        </button>
      </div>

      {onOpenMap && (
        <p className="note" style={{ marginTop: 4 }}>
          <button type="button" className="link-btn" onClick={onOpenMap}>
            How the pieces connect
          </button>
        </p>
      )}

      <p className="note" style={{ marginTop: 4 }}>
        {pr.repo} #{pr.number} · {pr.filesChanged} files · +{pr.additions} −{pr.deletions}
      </p>
    </div>
  );
}
