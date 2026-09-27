/**
 * StartScreen — StartS1: wide side-by-side Problem | Fix with screenshots above copy.
 */

import { useState } from 'react';
import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';
import { SHOW_HERO_STATS } from './features';
import { ShotImage, ShotLightbox } from './ShotsVisual';

/** Who took the before/after screenshots — shown as-is, so it has to be true. */
const SHOTS_BY: Record<NonNullable<Walkthrough['shots']>['by'] & string, string> = {
  'bob-verifier': 'taken by Bob in the running app',
  playwright: 'taken by a Playwright script',
  manual: 'taken by hand',
};

interface Props {
  walkthrough: Walkthrough;
  plain: PlainData;
  flow: Step[];
}

function HeroStats({ walkthrough, plain, flow }: Pick<Props, 'walkthrough' | 'plain' | 'flow'>) {
  const checks = flow.filter((s) => plain.steps[s.id]?.check).length;
  const wordCount = walkthrough.steps.reduce((a, s) => a + s.narration.split(/\s+/).length, 0);
  const minutes = Math.max(1, Math.round(wordCount / 150));
  const totalHunks = walkthrough.coverage?.totalHunks ?? walkthrough.hunks.length;
  const covered = (walkthrough.coverage?.explained ?? 0) + (walkthrough.coverage?.skipped ?? 0);
  return (
    <div className="hero-stats">
      <div className="stat"><b>{flow.length}</b><span>short steps</span></div>
      <div className="stat"><b>{checks}</b><span>things to check</span></div>
      <div className="stat"><b>~{minutes} min</b><span>to listen</span></div>
      <div className="stat"><b>{covered}/{totalHunks}</b><span>diff hunks covered</span></div>
    </div>
  );
}

export function StartScreen({ walkthrough, plain, flow }: Props) {
  const pr = walkthrough.pr;
  const shots = walkthrough.shots;
  const [owner, repo] = (pr.repo ?? '/').split('/');
  const [open, setOpen] = useState<'before' | 'after' | null>(null);
  const shotProps = shots ? { shots, owner, repo, number: pr.number, onOpen: setOpen } : null;

  return (
    <div className={`v2card${shots ? ' start-s1' : ''}`}>
      <div className="v2eyebrow">Pull request walkthrough</div>
      <h1 className="v2h1">{plain.title}</h1>

      <div className={`pf${shots ? ' start-s1' : ''}`}>
        <section className="p">
          {shotProps && <ShotImage {...shotProps} side="before" />}
          <h3 className="pf-label pf-label-bad">
            <span className="pf-dot" aria-hidden="true" />
            Problem
          </h3>
          <p>{plain.problem}</p>
        </section>
        <section className="f">
          {shotProps && <ShotImage {...shotProps} side="after" />}
          <h3 className="pf-label pf-label-good">
            <span className="pf-dot" aria-hidden="true" />
            Fix
          </h3>
          <p>{plain.fix}</p>
        </section>
      </div>

      {shots && (shots.caption || shots.by) && (
        <p className="note" style={{ marginTop: -8 }}>
          Screenshots{shots.by ? ` ${SHOTS_BY[shots.by]}` : ''}{shots.caption ? `: ${shots.caption}` : ''}
        </p>
      )}

      {!shots && (
        <p className="note" style={{ marginTop: -8 }}>
          {walkthrough.verification?.status === 'skipped' && walkthrough.verification.skipReason
            ? `No before/after screenshots — ${walkthrough.verification.skipReason}`
            : 'No before/after screenshots — this change isn’t visible in the UI (or screenshots weren’t taken for this walkthrough).'}
        </p>
      )}

      {SHOW_HERO_STATS && <HeroStats walkthrough={walkthrough} plain={plain} flow={flow} />}

      <p className="note" style={{ marginTop: 4 }}>
        {pr.repo} #{pr.number} · {pr.filesChanged} files · +{pr.additions} −{pr.deletions}
      </p>

      {shots && open && (
        <ShotLightbox shots={shots} side={open} owner={owner} repo={repo} number={pr.number} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
