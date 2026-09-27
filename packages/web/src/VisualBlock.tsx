/**
 * VisualBlock — renders the visual element for a step screen.
 * Supports: flow, symptoms, map, layers, try.
 */

import { Fragment, useState } from 'react';
import type { Walkthrough, Step, GraphEdge, SymptomItem } from '@pr-walkthrough/shared';
import type { PlainVisual } from './v2types';
import { MapSvg, MapLegend } from './MapSvg';
import { ShotsVisual, SingleShotVisual } from './ShotsVisual';
import { shotUrl } from './staticMode';

function symptomText(item: SymptomItem): string {
  return typeof item === 'string' ? item : item.text;
}

function symptomSrc(item: SymptomItem): string | undefined {
  return typeof item === 'string' ? undefined : item.src;
}

function SymptomsVisual({
  items,
  owner,
  repo,
  number,
}: {
  items: SymptomItem[];
  owner: string;
  repo: string;
  number: number;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const withShots = items.some((i) => symptomSrc(i));

  return (
    <div className={`visual${withShots ? ' symptoms-shots' : ''}`}>
      <ul className={`symptoms${withShots ? ' symptoms-with-shots' : ''}`}>
        {items.map((item, i) => {
          const text = symptomText(item);
          const src = symptomSrc(item);
          return (
            <li key={i} className={src ? 'symptom-card' : undefined}>
              {src && (
                <button
                  type="button"
                  className="symptom-shot"
                  onClick={() => setOpen(src)}
                  aria-label={`${text} — open full size`}
                >
                  <img src={shotUrl(owner, repo, number, src)} alt="" className="symptom-shot-img" />
                </button>
              )}
              <div className="symptom-copy">
                <span className="ic" aria-hidden="true">!</span>
                <span>{text}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {open && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Symptom screenshot">
          <button type="button" className="lightbox-scrim" aria-label="Close" onClick={() => setOpen(null)} />
          <div className="lightbox-body">
            <div className="lightbox-h">
              <span className="shot-cap shot-cap--bad" style={{ margin: 0 }}>Before</span>
              <button type="button" className="x-btn" onClick={() => setOpen(null)} aria-label="Close">×</button>
            </div>
            <img className="lightbox-img" src={shotUrl(owner, repo, number, open)} alt="" />
          </div>
        </div>
      )}
    </div>
  );
}

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
    const [owner, repo] = (walkthrough.pr.repo ?? '/').split('/');
    return (
      <SymptomsVisual
        items={visual.items}
        owner={owner}
        repo={repo}
        number={walkthrough.pr.number}
      />
    );
  }

  if (visual.type === 'flow') {
    const hasBad = visual.rows.some((row) => row.some(([, cls]) => cls === 'bad'));
    const hasGood = visual.rows.some((row) => row.some(([, cls]) => cls === 'good'));
    return (
      <div className="visual flows">
        {visual.rows.map((row, ri) => (
          <div className="flow" key={ri}>
            {row.map(([label, cls], ki) => (
              <Fragment key={ki}>
                {ki > 0 && (
                  <span className="arrow" aria-hidden="true">
                    <span className="arr-h">→</span>
                    <span className="arr-v">↓</span>
                  </span>
                )}
                <span className={`node ${cls}`}>{label}</span>
              </Fragment>
            ))}
          </div>
        ))}
        {(hasBad || hasGood) && (
          <p className="flow-legend">
            {hasBad && <span><i className="swatch bad" /> wrong outcome</span>}
            {hasGood && <span><i className="swatch good" /> fixed outcome</span>}
          </p>
        )}
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

  if (visual.type === 'shot') {
    const [owner, repo] = (walkthrough.pr.repo ?? '/').split('/');
    return (
      <SingleShotVisual
        side={visual.side}
        tone={visual.tone}
        caption={visual.caption}
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
