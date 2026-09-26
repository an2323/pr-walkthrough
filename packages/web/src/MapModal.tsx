/**
 * MapModal — on-demand "How the pieces connect".
 * Before / After / Both; optional focusNode = "you are here" when opened from a step.
 */

import { useEffect, useState } from 'react';
import type { Walkthrough, GraphEdge } from '@pr-walkthrough/shared';
import { MapSvg, MapLegend } from './MapSvg';

type Mode = 'before' | 'after' | 'both';

interface Props {
  walkthrough: Walkthrough;
  edgesPlain?: Record<string, string>;
  focusNode?: string;
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

export function MapModal({ walkthrough, edgesPlain = {}, focusNode, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('both');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const edges = edgesFor(walkthrough, mode);
  const focusLabel = focusNode
    ? walkthrough.graph.nodes.find((n) => n.id === focusNode)?.label
    : undefined;

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
          {focusLabel && (
            <p className="map-here">This step · {focusLabel}</p>
          )}
        </div>
        <div className="map-modal-body">
          <MapSvg
            graph={walkthrough.graph}
            edges={edges}
            allNodes={true}
            focusNode={focusNode}
            edgesPlain={edgesPlain}
          />
          <MapLegend />
        </div>
      </div>
    </div>
  );
}
