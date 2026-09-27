/**
 * Before/after screenshots. Highlight boxes are drawn into the image files
 * (packages/server/src/shots/annotate.ts); click an image to see it full size.
 */

import { useEffect, useState } from 'react';
import type { Shots, ShotSide } from '@pr-walkthrough/shared';
import { shotUrl } from './staticMode';

type Side = 'before' | 'after';

const LABEL: Record<Side, string> = { before: 'Before', after: 'After' };

interface ShotImageProps {
  shots: Shots;
  side: Side;
  owner: string;
  repo: string;
  number: number;
  onOpen: (side: Side) => void;
  /** Override the Before/After caption — e.g. "Now" on the summary screen. */
  label?: string;
}

export function ShotImage({ shots, side, owner, repo, number, onOpen, label }: ShotImageProps) {
  const tone = side === 'before' ? 'bad' : 'good';
  return (
    <figure className="shot-frame">
      <figcaption className={`shot-cap shot-cap--${tone}`}>{label ?? LABEL[side]}</figcaption>
      <button
        type="button"
        className="shot-img-wrap"
        onClick={() => onOpen(side)}
        aria-label={`${LABEL[side]} screenshot — open full size`}
      >
        <img src={shotUrl(owner, repo, number, shots[side].src)} alt={`${LABEL[side]} screenshot`} className="shot-img" />
      </button>
      <span className="shot-hint">Click to enlarge</span>
    </figure>
  );
}

interface LightboxProps {
  shots: Shots;
  side: Side;
  owner: string;
  repo: string;
  number: number;
  onClose: () => void;
}

export function ShotLightbox({ shots, side: initial, owner, repo, number, onClose }: LightboxProps) {
  const [side, setSide] = useState<Side>(initial);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.stopPropagation();
        setSide((s) => (s === 'before' ? 'after' : 'before'));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${LABEL[side]} screenshot`}>
      <button type="button" className="lightbox-scrim" aria-label="Close" onClick={onClose} />
      <div className="lightbox-body">
        <div className="lightbox-h">
          <div className="seg" role="group" aria-label="Before or after">
            {(['before', 'after'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)}>
                {LABEL[s]}
              </button>
            ))}
          </div>
          <button type="button" className="x-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        <img
          className="lightbox-img"
          src={shotUrl(owner, repo, number, shots[side].src)}
          alt={`${LABEL[side]} screenshot`}
        />
        {shots.caption && <p className="lightbox-cap">{shots.caption}</p>}
      </div>
    </div>
  );
}

interface Props {
  shots: Shots;
  owner: string;
  repo: string;
  number: number;
}

/** Side-by-side pair, used when a step's visual is `shots`. */
export function ShotsVisual({ shots, owner, repo, number }: Props) {
  const [open, setOpen] = useState<Side | null>(null);
  const common = { shots, owner, repo, number };
  return (
    <div className="visual shots">
      {shots.caption && <div className="map-cap">{shots.caption}</div>}
      <div className="shots-pair">
        <ShotImage {...common} side="before" onOpen={setOpen} />
        <ShotImage {...common} side="after" onOpen={setOpen} />
      </div>
      {open && <ShotLightbox {...common} side={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

interface SingleShotProps {
  side: ShotSide;
  tone?: 'bad' | 'good';
  caption?: string;
  owner: string;
  repo: string;
  number: number;
}

/** One screenshot as Problem evidence (`visual.type === "shot"`). */
export function SingleShotVisual({ side, tone, caption, owner, repo, number }: SingleShotProps) {
  const [open, setOpen] = useState(false);
  const label = tone === 'good' ? 'After' : tone === 'bad' ? 'Before' : 'Screenshot';
  const toneClass = tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : 'bad';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <div className="visual shots">
      {caption && <div className="map-cap">{caption}</div>}
      <div className="shots-pair shots-pair-single">
        <figure className="shot-frame">
          <figcaption className={`shot-cap shot-cap--${toneClass}`}>{label}</figcaption>
          <button
            type="button"
            className="shot-img-wrap"
            onClick={() => setOpen(true)}
            aria-label={`${label} screenshot — open full size`}
          >
            <img
              src={shotUrl(owner, repo, number, side.src)}
              alt={`${label} screenshot`}
              className="shot-img"
            />
          </button>
          <span className="shot-hint">Click to enlarge</span>
        </figure>
      </div>
      {open && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${label} screenshot`}>
          <button type="button" className="lightbox-scrim" aria-label="Close" onClick={() => setOpen(false)} />
          <div className="lightbox-body">
            <div className="lightbox-h">
              <span className={`shot-cap shot-cap--${toneClass}`} style={{ margin: 0 }}>{label}</span>
              <button type="button" className="x-btn" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
            <img
              className="lightbox-img"
              src={shotUrl(owner, repo, number, side.src)}
              alt={`${label} screenshot`}
            />
            {caption && <p className="lightbox-cap">{caption}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

