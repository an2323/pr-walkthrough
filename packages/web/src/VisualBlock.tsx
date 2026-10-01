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
import { symptomForSentence } from './symptomHighlight';

function symptomText(item: SymptomItem): string {
  return typeof item === 'string' ? item : item.text;
}

function symptomSrc(item: SymptomItem): string | undefined {
  return typeof item === 'string' ? undefined : item.src;
}

/**
 * The Problem block. Symptoms with a picture are cards in one row of equal height, each as wide as its picture's
 * shape needs (a desktop frame wide, a phone frame narrow), so both are shown whole and readable. Symptoms
 * without a picture are a compact list under the cards. Every symptom keeps its number from the text, so a card
 * and a list line are easy to match to what the narration says.
 */
function SymptomsVisual({
  items,
  owner,
  repo,
  number,
  activeIndex,
}: {
  items: SymptomItem[];
  owner: string;
  repo: string;
  number: number;
  /** Which symptom the current narration sentence maps to (or null). */
  activeIndex: number | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // width / height of each picture once loaded; a desktop frame until then
  const [ratio, setRatio] = useState<Record<string, number>>({});
  const numbered = items.map((item, i) => ({ i, text: symptomText(item), src: symptomSrc(item) }));
  const withShot = numbered.filter((x) => x.src);
  const plain = numbered.filter((x) => !x.src);
  const many = items.length > 1;
  const mark = (i: number) => (many ? String(i + 1) : '!');

  return (
    <div className={`visual${withShot.length ? ' symptoms-shots' : ''}`}>
      {withShot.length > 0 && (
        <ul className="symptom-cards">
          {withShot.map(({ i, text, src }) => {
            const r = ratio[src!] ?? 1.6;
            return (
              <li
                key={i}
                className={`symptom-card${activeIndex === i ? ' is-narrating' : ''}${r < 1 ? ' is-tall' : ''}`}
                style={{ flexGrow: r, flexBasis: 0, maxWidth: `calc(${r} * var(--symptom-h))` }}
              >
                <button type="button" className="symptom-shot" onClick={() => setOpen(src!)} aria-label={`${text} — open full size`}>
                  <img
                    src={shotUrl(owner, repo, number, src!)}
                    alt=""
                    className="symptom-shot-img"
                    onLoad={(e) => {
                      const im = e.currentTarget;
                      if (im.naturalWidth && im.naturalHeight) setRatio((m) => ({ ...m, [src!]: im.naturalWidth / im.naturalHeight }));
                    }}
                  />
                </button>
                <div className="symptom-copy">
                  <span className="ic" aria-hidden="true">{mark(i)}</span>
                  <span>{text}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {plain.length > 0 && (
        <ul className={`symptoms${withShot.length ? ' symptoms-rest' : ''}`}>
          {plain.map(({ i, text }) => (
            <li key={i} className={activeIndex === i ? 'is-narrating' : undefined}>
              <span className="ic" aria-hidden="true">{mark(i)}</span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}
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
  /** Index of the narration sentence currently playing, or null when silent. */
  narrationSentence?: number | null;
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
  narrationSentence = null,
}: Props) {
  if (visual.type === 'symptoms') {
    const [owner, repo] = (walkthrough.pr.repo ?? '/').split('/');
    return (
      <SymptomsVisual
        items={visual.items}
        owner={owner}
        repo={repo}
        number={walkthrough.pr.number}
        activeIndex={symptomForSentence(narrationSentence, step.narration ?? '', visual.items.map(symptomText))}
      />
    );
  }

  if (visual.type === 'flow') {
    const nodes = visual.rows.flat();
    const hasBad = nodes.some(([, cls]) => cls === 'bad');
    const hasGood = nodes.some(([, cls]) => cls === 'good');
    const hasOld = nodes.some(([, cls]) => cls === 'old');
    return (
      <div className="visual flows">
        {visual.rows.map((row, ri) => (
          <div className="flow-group" key={ri}>
            {visual.rowTitles?.[ri] && <h4 className="flow-title">{visual.rowTitles[ri]}</h4>}
            <div className="flow">
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
          </div>
        ))}
        {(hasBad || hasGood || hasOld) && (
          <p className="flow-legend">
            {hasBad && <span><i className="swatch bad" /> wrong outcome</span>}
            {hasGood && <span><i className="swatch good" /> fixed outcome</span>}
            {hasOld && <span><i className="swatch old" /> removed by the PR</span>}
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
