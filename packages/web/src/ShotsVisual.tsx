/**
 * ShotsVisual — before/after screenshots with viewer-drawn highlight boxes (ST6g).
 * Desktop: side by side. Narrow screens: Before/After toggle.
 */

import { useState } from 'react';
import type { ShotHighlight, ShotSide } from '@pr-walkthrough/shared';
import { shotUrl } from './staticMode';

interface Props {
  before: ShotSide;
  after: ShotSide;
  caption?: string;
  owner: string;
  repo: string;
  number: number;
}

function HighlightBoxes({ highlights, tone }: { highlights?: ShotHighlight[]; tone: 'bad' | 'good' }) {
  if (!highlights?.length) return null;
  return (
    <>
      {highlights.map((h, i) => (
        <div
          key={i}
          className={`shot-hl shot-hl--${tone}`}
          style={{
            left: `${h.x * 100}%`,
            top: `${h.y * 100}%`,
            width: `${h.w * 100}%`,
            height: `${h.h * 100}%`,
          }}
        >
          {h.label && <span className="shot-hl-label">{h.label}</span>}
        </div>
      ))}
    </>
  );
}

function ShotFrame({
  side,
  label,
  tone,
  src,
}: {
  side: ShotSide;
  label: string;
  tone: 'bad' | 'good';
  src: string;
}) {
  return (
    <figure className="shot-frame">
      <figcaption className={`shot-cap shot-cap--${tone}`}>{label}</figcaption>
      <div className="shot-img-wrap">
        <img src={src} alt={label} className="shot-img" />
        <HighlightBoxes highlights={side.highlights} tone={tone} />
      </div>
    </figure>
  );
}

export function ShotsVisual({ before, after, caption, owner, repo, number }: Props) {
  const [mode, setMode] = useState<'before' | 'after'>('before');
  const beforeSrc = shotUrl(owner, repo, number, before.src);
  const afterSrc = shotUrl(owner, repo, number, after.src);

  return (
    <div className="visual shots">
      {caption && <div className="map-cap">{caption}</div>}

      <div className="shots-pair">
        <ShotFrame side={before} label="Before" tone="bad" src={beforeSrc} />
        <ShotFrame side={after} label="After" tone="good" src={afterSrc} />
      </div>

      <div className="shots-toggle" role="group" aria-label="Before or after">
        <button
          type="button"
          className={mode === 'before' ? 'on' : ''}
          aria-pressed={mode === 'before'}
          onClick={() => setMode('before')}
        >
          Before
        </button>
        <button
          type="button"
          className={mode === 'after' ? 'on' : ''}
          aria-pressed={mode === 'after'}
          onClick={() => setMode('after')}
        >
          After
        </button>
      </div>
      <div className="shots-one">
        {mode === 'before' ? (
          <ShotFrame side={before} label="Before" tone="bad" src={beforeSrc} />
        ) : (
          <ShotFrame side={after} label="After" tone="good" src={afterSrc} />
        )}
      </div>
    </div>
  );
}
