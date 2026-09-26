/**
 * TopBarV2 — top bar with PR name and chapter dots progress.
 */

import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';

const CH: Record<string, string> = {
  problem: 'Problem',
  fix: 'Fix',
  check: 'Try it',
};

interface Props {
  walkthrough: Walkthrough;
  plain: PlainData;
  flow: Step[];
  screenIndex: number; // -1 = start, 0..n-1 = steps, flow.length = summary
  onGo: (i: number) => void;
  onOpenMap?: () => void;
}

export function TopBarV2({ walkthrough, plain, flow, screenIndex, onGo, onOpenMap }: Props) {
  const pr = walkthrough.pr;

  const currentChapter =
    screenIndex >= 0 && screenIndex < flow.length
      ? plain.steps[flow[screenIndex].id]?.ch ?? null
      : null;

  return (
    <header className="v2top">
      <div className="v2pr">
        <b>{pr.repo}</b>
        <span> #{pr.number} · {pr.title}</span>
      </div>
      <div className="v2top-right">
        {onOpenMap && (
          <button type="button" className="map-btn" onClick={onOpenMap}>
            Map
          </button>
        )}
        <nav className="v2chapters" aria-label="Progress">
        {Object.entries(CH).map(([ch, label]) => {
          const chSteps = flow.filter((s) => plain.steps[s.id]?.ch === ch);
          if (chSteps.length === 0) return null;
          return (
            <div className={`v2ch${currentChapter === ch ? ' on' : ''}`} key={ch}>
              {label}
              <span className="v2dots">
                {chSteps.map((s) => {
                  const k = flow.indexOf(s);
                  let cls = '';
                  if (k === screenIndex) cls = 'now';
                  else if (k < screenIndex) cls = 'done';
                  return (
                    <button
                      key={s.id}
                      className={cls}
                      onClick={() => onGo(k)}
                      aria-label={`Step ${k + 1}: ${plain.steps[s.id]?.head ?? s.routeLabel}`}
                    />
                  );
                })}
              </span>
            </div>
          );
        })}
        </nav>
      </div>
    </header>
  );
}
