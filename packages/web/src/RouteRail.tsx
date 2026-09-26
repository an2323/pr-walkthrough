import type { Step, GraphNode } from '@pr-walkthrough/shared';
import './RouteRail.css';

interface Props {
  steps: Step[];
  nodeById: Record<string, GraphNode>;
  activeIndex: number;
  onSelect: (index: number) => void;
}

export function RouteRail({ steps, nodeById, activeIndex, onSelect }: Props) {
  return (
    <aside className="route-rail">
      <div className="route-rail__cap">Reasoning route</div>
      {steps.map((step, j) => {
        const node = nodeById[step.focusNode];
        const isActive = j === activeIndex;
        return (
          <div
            key={step.id}
            className={['rt', isActive ? 'on' : '', step.isDeadEnd ? 'dead' : ''].filter(Boolean).join(' ')}
            tabIndex={0}
            onClick={() => onSelect(j)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSelect(j); }}
            role="button"
            aria-pressed={isActive}
            aria-label={`Step ${j + 1}: ${step.routeLabel}`}
          >
            <span className="n">{j + 1}</span>
            <span>
              <span className="l">{step.routeLabel}</span>
              <span className="file">{node?.label ?? ''}</span>
            </span>
          </div>
        );
      })}
    </aside>
  );
}
