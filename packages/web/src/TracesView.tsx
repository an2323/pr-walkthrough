import type { TraceStep } from '@pr-walkthrough/shared';

interface Props {
  traces: TraceStep[][];
}

export function TracesView({ traces }: Props) {
  return (
    <div className="traces">
      {traces.map((trace, i) => (
        <div key={i} className="trace">
          {trace.map((step, j) => (
            <span key={j}>
              {j > 0 && <i>→</i>}
              <span className={step.status ?? ''}>{step.label}</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
