/**
 * MapModal — on-demand "How the pieces connect" (ST6g).
 * Before / After / Both; Both shows problem + fix edges together.
 */

import { useEffect, useState } from 'react';
import type { Walkthrough, GraphEdge } from '@pr-walkthrough/shared';
import { MapSvg, MapLegend } from './MapSvg';

type Mode = 'before' | 'after' | 'both';

interface Props {
  walkthrough: Walkthrough;
  edgesPlain?: Record<string, string>;
  onClose: () => void;
}

function edgesFor(w: Walkthrough, mode: Mode): GraphEdge[] {
  return w.graph.edges.filter((e) => {
    if (mode === 'both') return true;
    if (mode === 'before') {
      return e.state === 'before' || (e.state === 'unchanged' && !e.visibleFrom);
    }
    return e.state === 'after' || (e.state === 'unchanged' && !e.visibleUntil);
  });
}

export function MapModal({ walkthrough, edgesPlain = {}, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('both');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const edges = edgesFor(walkthrough, mode);

  return (
    <div className="map-layer" role="dialog" aria-modal="true" aria-label="How the pieces connect">
      <button type="button" className="scrim" aria-label="Close" onClick={onClose} />
      <div className="map-modal">
        <div className="map-modal-h">
          <h3>How the pieces connect</h3>
          <button type="button" className="x-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="map-top" style={{ padding: '0 20px' }}>
          <div className="seg" role="group" aria-label="Map mode">
            {(['before', 'after', 'both'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {m === 'both' ? 'Both' : m === 'before' ? 'Before' : 'After'}
              </button>
            ))}
          </div>
        </div>
        <div className="map-modal-body">
          <MapSvg
            graph={walkthrough.graph}
            edges={edges}
            allNodes={true}
            edgesPlain={edgesPlain}
          />
          <MapLegend />
        </div>
      </div>
    </div>
  );
}
