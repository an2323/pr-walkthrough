/**
 * StartScreen — the first screen with PR stats, Before/After map, and problem/fix summary.
 */

import { useState } from 'react';
import type { Walkthrough, Step, GraphEdge } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';
import { MapSvg, MapLegend } from './MapSvg';

interface Props {
  walkthrough: Walkthrough;
  plain: PlainData;
  flow: Step[];
  onStart: () => void;
  onListenAll: () => void;
}

function edgeSet(w: Walkthrough, mode: 'before' | 'after'): GraphEdge[] {
  return w.graph.edges.filter((e) => {
    if (mode === 'before') {
      return e.state === 'before' || (e.state === 'unchanged' && !e.visibleFrom);
    }
    return e.state === 'after' || (e.state === 'unchanged' && !e.visibleUntil);
  });
}

export function StartScreen({ walkthrough, plain, flow, onStart, onListenAll }: Props) {
  const [mapMode, setMapMode] = useState<'before' | 'after'>('before');
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

  const edges = edgeSet(walkthrough, mapMode);

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

      <section className="visual mapbox">
        <div className="map-top">
          <h3>How the pieces connect</h3>
          <div className="seg" role="group" aria-label="Before or after the PR">
            <button
              aria-pressed={mapMode === 'before'}
              onClick={() => setMapMode('before')}
            >
              Before
            </button>
            <button
              aria-pressed={mapMode === 'after'}
              onClick={() => setMapMode('after')}
            >
              After
            </button>
          </div>
        </div>
        <MapSvg
          graph={walkthrough.graph}
          edges={edges}
          allNodes={true}
          edgesPlain={plain.edges}
        />
        <MapLegend />
      </section>

      <div className="cta">
        <button className="v2btn primary" onClick={onStart}>
          Start →
        </button>
        <button className="v2btn" onClick={onListenAll}>
          ▶ Listen instead
        </button>
      </div>

      <p className="note" style={{ marginTop: 4 }}>
        {pr.repo} #{pr.number} · {pr.filesChanged} files · +{pr.additions} −{pr.deletions}
      </p>
    </div>
  );
}
