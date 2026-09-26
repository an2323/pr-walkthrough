/**
 * MapSvg — renders the architecture graph as SVG.
 * Ported directly from the prototype mapSvg() function.
 */

import type { Graph, GraphEdge, GraphNode } from '@pr-walkthrough/shared';

interface Props {
  graph: Graph;
  edges: GraphEdge[];
  focusNode?: string;
  allNodes?: boolean;
  edgesPlain?: Record<string, string>;
}

function tone(e: GraphEdge): string {
  if (e.problem) return 'bad';
  if (e.state === 'after') return 'good';
  if (e.state === 'before') return 'faint';
  return 'muted';
}

export function MapSvg({ graph, edges, focusNode, allNodes = false, edgesPlain = {} }: Props) {
  const used = new Set(edges.flatMap((e) => [e.from, e.to]).concat(focusNode ? [focusNode] : []));
  const nodes: GraphNode[] = allNodes
    ? graph.nodes
    : graph.nodes.filter((n) => used.has(n.id));

  const cols = [...new Set(nodes.map((n) => n.layout?.col ?? 0))].sort((a, b) => a - b);
  const rows = [...new Set(nodes.map((n) => n.layout?.row ?? 0))].sort((a, b) => a - b);

  const NW = 176, NH = 50, GX = 150, GY = 46, P = 6;

  const pos: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n) => {
    pos[n.id] = {
      x: P + cols.indexOf(n.layout?.col ?? 0) * (NW + GX),
      y: P + rows.indexOf(n.layout?.row ?? 0) * (NH + GY),
    };
  });

  const Wd = P * 2 + cols.length * NW + (cols.length - 1) * GX;
  const Hd = P * 2 + rows.length * NH + (rows.length - 1) * GY;

  function seg(a: { x: number; y: number }, b: { x: number; y: number }): [number, number, number, number] {
    const ax = a.x + NW / 2, ay = a.y + NH / 2;
    const bx = b.x + NW / 2, by = b.y + NH / 2;
    const dx = bx - ax, dy = by - ay;
    const t = Math.min(Math.abs(NW / 2 / (dx || 1e-9)), Math.abs(NH / 2 / (dy || 1e-9)));
    return [ax + dx * t, ay + dy * t, bx - dx * t, by - dy * t];
  }

  const markerColors = ['bad', 'good', 'faint', 'muted'];

  return (
    <svg
      className="mapsvg"
      viewBox={`0 0 ${Wd} ${Hd}`}
      style={{ maxWidth: Wd }}
      role="img"
      aria-label="How the pieces connect"
    >
      <defs>
        {markerColors.map((c) => (
          <marker
            key={c}
            id={`mk-${c}`}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0,0 L8,4 L0,8 z" fill={`var(--${c})`} />
          </marker>
        ))}
      </defs>

      {/* Edges */}
      {edges.map((e) => {
        const pa = pos[e.from], pb = pos[e.to];
        if (!pa || !pb) return null;
        const [x1, y1, x2, y2] = seg(pa, pb);
        const c = tone(e);
        const lbl = e.plainLabel ?? (edgesPlain[e.label ?? ''] ?? e.label ?? '');
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        const w = lbl.length * 6.4 + 12;
        return (
          <g key={e.id}>
            <title>{e.label ?? ''}</title>
            <line
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={`var(--${c})`}
              strokeWidth={e.state === 'unchanged' ? 1.3 : 2}
              strokeDasharray={e.state === 'before' ? '5 4' : undefined}
              markerEnd={`url(#mk-${c})`}
            />
            {lbl && (
              <>
                <rect
                  x={mx - w / 2} y={my - 10}
                  width={w} height={20} rx={4}
                  fill="var(--panel)"
                />
                <text
                  x={mx} y={my + 4}
                  textAnchor="middle"
                  fontSize={11.5}
                  fill={`var(--${c === 'faint' ? 'muted' : c})`}
                >
                  {lbl}
                </text>
              </>
            )}
          </g>
        );
      })}

      {/* Nodes */}
      {nodes.map((n) => {
        const p = pos[n.id];
        if (!p) return null;
        const f = n.id === focusNode;
        return (
          <g key={n.id}>
            <title>{n.file ?? ''}</title>
            <rect
              x={p.x} y={p.y}
              width={NW} height={NH}
              rx={9}
              fill={f ? 'var(--accent-soft)' : 'var(--raised)'}
              stroke={f ? 'var(--accent)' : 'var(--line)'}
              strokeWidth={f ? 2 : 1}
            />
            <text
              x={p.x + NW / 2} y={p.y + 21}
              textAnchor="middle"
              fontSize={13}
              fontWeight={600}
              fill="var(--ink)"
            >
              {n.label}
            </text>
            {n.sublabel && (
              <text
                x={p.x + NW / 2} y={p.y + 38}
                textAnchor="middle"
                fontSize={11.5}
                fill="var(--muted)"
              >
                {n.sublabel}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function MapLegend() {
  return (
    <div className="legend">
      <span><i className="lg bad"></i>the problem path</span>
      <span><i className="lg faint"></i>removed by the PR</span>
      <span><i className="lg good"></i>added by the PR</span>
    </div>
  );
}
