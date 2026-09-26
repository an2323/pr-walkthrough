import { useEffect, useRef } from 'react';
import type { Graph, Step } from '@pr-walkthrough/shared';
import './GraphView.css';

interface Props {
  graph: Graph;
  steps: Step[];
  activeIndex: number;
}

const NW = 200;
const NH = 54;
const CG = 110;
const RG = 46;
const P = 28;
const PX = 150;

function pos(node: { layout?: { col: number; row: number } }) {
  const col = node.layout?.col ?? 0;
  const row = node.layout?.row ?? 0;
  return { x: PX + col * (NW + CG), y: P + row * (NH + RG) };
}

function ctr(node: { layout?: { col: number; row: number } }) {
  const p = pos(node);
  return { x: p.x + NW / 2, y: p.y + NH / 2 };
}

function clip(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const tx = dx ? (NW / 2) / Math.abs(dx) : 1e9;
  const ty = dy ? (NH / 2) / Math.abs(dy) : 1e9;
  const t = Math.min(tx, ty);
  return { x: a.x + dx * t, y: a.y + dy * t };
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getCSSVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function GraphView({ graph, steps, activeIndex }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  const cols = Math.max(...graph.nodes.map((n) => n.layout?.col ?? 0)) + 1;
  const rows = Math.max(...graph.nodes.map((n) => n.layout?.row ?? 0)) + 1;
  const W = PX * 2 + cols * NW + (cols - 1) * CG;
  const Hh = P * 2 + rows * NH + (rows - 1) * RG;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const step = activeIndex + 1;
    const nodeById = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));

    const c = {
      ink: getCSSVar('--ink'),
      muted: getCSSVar('--muted'),
      faint: getCSSVar('--faint'),
      line: getCSSVar('--line'),
      acc: getCSSVar('--accent'),
      accs: getCSSVar('--accent-soft'),
      dan: getCSSVar('--danger'),
      panel: getCSSVar('--panel'),
    };

    const markers = ['acc', 'dan', 'faint']
      .map(
        (k) =>
          `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">` +
          `<path d="M0 0L10 5L0 10z" fill="${c[k as keyof typeof c]}"/></marker>`
      )
      .join('');

    let h = `<defs>${markers}</defs>`;

    // Draw edges
    graph.edges.forEach((e) => {
      if (e.visibleFrom && step < e.visibleFrom) return;
      if (e.visibleUntil && step > e.visibleUntil) return;
      const fromNode = nodeById[e.from];
      const toNode = nodeById[e.to];
      if (!fromNode || !toNode) return;
      const A = ctr(fromNode);
      const B = ctr(toNode);
      const a = clip(A, B);
      const b = clip(B, A);
      const col = e.problem ? c.dan : e.state === 'after' ? c.acc : c.faint;
      const mk = e.problem ? 'dan' : e.state === 'after' ? 'acc' : 'faint';
      const dash = e.problem || e.state === 'before' ? ' stroke-dasharray="6 4"' : '';
      h += `<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="${col}" stroke-width="1.6" fill="none"${dash} marker-end="url(#m-${mk})"/>`;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const vert = Math.abs(a.x - b.x) < 2;
      if (e.label) {
        h += `<text x="${vert ? mx + 8 : mx}" y="${vert ? my + 4 : my - 7}" font-size="12" font-family="IBM Plex Mono, monospace" fill="${col}" text-anchor="${vert ? 'start' : 'middle'}">${esc(e.label)}</text>`;
      }
    });

    // Draw nodes
    const visited = new Set(steps.slice(0, activeIndex).map((s) => s.focusNode));
    const cur = steps[activeIndex]?.focusNode;

    graph.nodes.forEach((n) => {
      if (n.visibleFrom && step < n.visibleFrom) return;
      const p = pos(n);
      const on = n.id === cur;
      const was = visited.has(n.id);
      h += `<g>`;
      h += `<rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="7" fill="${on ? c.accs : c.panel}" stroke="${on ? c.acc : was ? c.muted : c.line}" stroke-width="${on ? 2 : 1}"/>`;
      h += `<text x="${p.x + NW / 2}" y="${p.y + 23}" text-anchor="middle" font-size="14" font-weight="500" font-family="IBM Plex Sans, sans-serif" fill="${c.ink}">${esc(n.label)}</text>`;
      if (n.sublabel) {
        h += `<text x="${p.x + NW / 2}" y="${p.y + 41}" text-anchor="middle" font-size="12" font-family="IBM Plex Sans, sans-serif" fill="${c.muted}">${esc(n.sublabel)}</text>`;
      }
      h += `</g>`;
    });

    // Draw hop arrow between consecutive focusNodes
    if (activeIndex > 0 && steps[activeIndex - 1]?.focusNode !== cur && cur) {
      const prevNode = nodeById[steps[activeIndex - 1].focusNode];
      const curNode = nodeById[cur];
      if (prevNode && curNode) {
        const A = ctr(prevNode);
        const B = ctr(curNode);
        const a = clip(A, B);
        const b = clip(B, A);
        const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.45;
        const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.45;
        const isDeadEnd = steps[activeIndex]?.isDeadEnd;
        const hopCol = isDeadEnd ? c.dan : c.acc;
        const hopMk = isDeadEnd ? 'dan' : 'acc';
        h += `<path d="M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}" stroke="${hopCol}" stroke-width="2.4" fill="none" stroke-dasharray="2 5" stroke-linecap="round" marker-end="url(#m-${hopMk})"/>`;
      }
    }

    svg.innerHTML = h;
  }, [graph, steps, activeIndex]);

  return (
    <div className="graph">
      <svg
        ref={svgRef}
        id="g"
        role="img"
        aria-label="Files touched by the pull request and how data flows between them"
        viewBox={`0 0 ${W} ${Hh}`}
        width={W}
        style={{ display: 'block', margin: '0 auto' }}
      />
    </div>
  );
}
