/**
 * StartScreen — Problem (+ before screenshot), Fix (+ after screenshot), Start / Listen.
 */

import { useState } from 'react';
import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';
import { SHOW_HERO_STATS } from './features';
import { ShotImage, ShotLightbox } from './ShotsVisual';

interface Props {
  walkthrough: Walkthrough;
  plain: PlainData;
  flow: Step[];
  onStart: () => void;
  onListenAll: () => void;
  onOpenMap?: () => void;
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

export function StartScreen({ walkthrough, plain, flow, onStart, onListenAll, onOpenMap }: Props) {
  const pr = walkthrough.pr;
  const shots = walkthrough.shots;
  const [owner, repo] = (pr.repo ?? '/').split('/');
  const [open, setOpen] = useState<'before' | 'after' | null>(null);
  const shotProps = shots ? { shots, owner, repo, number: pr.number, onOpen: setOpen } : null;

  return (
    <div className="v2card">
      <div className="v2eyebrow">Pull request walkthrough</div>
      <h1 className="v2h1">{plain.title}</h1>

      <div className={`pf${shots ? ' stacked' : ''}`}>
        <section className="p">
          <h3>Problem</h3>
          <p>{plain.problem}</p>
          {shotProps && <ShotImage {...shotProps} side="before" />}
        </section>
        <section className="f">
          <h3>Fix</h3>
          <p>{plain.fix}</p>
          {shotProps && <ShotImage {...shotProps} side="after" />}
        </section>
      </div>

      {shots?.caption && <p className="note" style={{ marginTop: -8 }}>Screenshots: {shots.caption}</p>}

      {SHOW_HERO_STATS && <HeroStats walkthrough={walkthrough} plain={plain} flow={flow} />}

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

      {shots && open && (
        <ShotLightbox shots={shots} side={open} owner={owner} repo={repo} number={pr.number} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
