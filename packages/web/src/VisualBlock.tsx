/**
 * VisualBlock — renders the visual element for a step screen.
 * Supports: flow, symptoms, map, layers, try.
 */

import { Fragment } from 'react';
import type { Walkthrough, Step, GraphEdge } from '@pr-walkthrough/shared';
import type { PlainVisual } from './v2types';
import { MapSvg, MapLegend } from './MapSvg';
import { ShotsVisual } from './ShotsVisual';

interface Props {
  visual: PlainVisual;
  walkthrough: Walkthrough;
  step: Step;
  stepIndex: number; // 1-based step number
  edgesPlain?: Record<string, string>;
  verifiedItems: Record<number, boolean>;
  onVerify: (k: number, v: boolean) => void;
}

function edgeSet(
  graph: Walkthrough['graph'],
  mode: 'before' | 'after',
  stepNo?: number
): GraphEdge[] {
  return graph.edges.filter((e) => {
    if (stepNo !== undefined) {
      return (e.visibleFrom ?? 1) <= stepNo && stepNo <= (e.visibleUntil ?? 1e9);
    }
    if (mode === 'before') {
      return e.state === 'before' || (e.state === 'unchanged' && !e.visibleFrom);
    }
    return e.state === 'after' || (e.state === 'unchanged' && !e.visibleUntil);
  });
}

export function VisualBlock({
  visual,
  walkthrough,
  step,
  stepIndex,
  edgesPlain = {},
  verifiedItems,
  onVerify,
}: Props) {
  if (visual.type === 'symptoms') {
    return (
      <div className="visual">
        <ul className="symptoms">
          {visual.items.map((t, i) => (
            <li key={i}>
              <span className="ic">!</span>
              {t}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (visual.type === 'flow') {
    return (
      <div className="visual flows">
        {visual.rows.map((row, ri) => (
          <div className="flow" key={ri}>
            {row.map(([label, cls], ki) => (
              <Fragment key={ki}>
                {ki > 0 && <span className="arrow">→</span>}
                <span className={`node ${cls}`}>{label}</span>
              </Fragment>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (visual.type === 'layers') {
    const Stack = ({ title, items }: { title: string; items: [string, number, string?][] }) => (
      <div className="stack">
        <h4>{title}</h4>
        {items.map(([name, z, cls], i) => (
          <div className={`layer${cls ? ' hl ' + cls : ''}`} key={i}>
            <span>{name}</span>
            <span>{z}</span>
          </div>
        ))}
      </div>
    );
    return (
      <div className="visual">
        <div className="layers">
          <Stack title="Before · top is drawn last" items={visual.before} />
          <span className="mid">→</span>
          <Stack title="After" items={visual.after} />
        </div>
      </div>
    );
  }

  if (visual.type === 'map') {
    const edges = edgeSet(walkthrough.graph, 'after', stepIndex);
    return (
      <div className="visual mapbox">
        {visual.caption && <div className="map-cap">{visual.caption}</div>}
        <MapSvg
          graph={walkthrough.graph}
          edges={edges}
          focusNode={step.focusNode}
          edgesPlain={edgesPlain}
        />
        <MapLegend />
      </div>
    );
  }

  if (visual.type === 'shots') {
    const [owner, repo] = (walkthrough.pr.repo ?? '/').split('/');
    return (
      <ShotsVisual
        shots={{ before: visual.before, after: visual.after, caption: visual.caption }}
        owner={owner}
        repo={repo}
        number={walkthrough.pr.number}
      />
    );
  }

  if (visual.type === 'try') {
    const scenarios = walkthrough.verification?.scenario ?? [];
    return (
      <div className="visual sum-list">
        {scenarios.map((t, k) => (
          <label className="sum-item" style={{ cursor: 'pointer' }} key={k}>
            <input
              type="checkbox"
              checked={!!verifiedItems[k]}
              onChange={(e) => onVerify(k, e.target.checked)}
            />
            <span>{t.replace(/\s*→\s*/, ' → ')}</span>
          </label>
        ))}
      </div>
    );
  }

  return null;
}
