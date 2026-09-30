/**
 * TopBarV2 — PR name, Diagram, chapter/part progress dots.
 * When walkthrough.parts has ≥2 entries, Fix steps are grouped under Part labels.
 */

import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';
import { BrandLink } from './BrandLink';

interface Props {
  walkthrough: Walkthrough;
  plain: PlainData;
  flow: Step[];
  screenIndex: number; // -1 = start, 0..n-1 = steps, flow.length = summary
  onGo: (i: number) => void;
  onOpenMap?: () => void;
}

function Dot({
  step,
  flow,
  screenIndex,
  plain,
  onGo,
}: {
  step: Step;
  flow: Step[];
  screenIndex: number;
  plain: PlainData;
  onGo: (i: number) => void;
}) {
  const k = flow.indexOf(step);
  let cls = '';
  if (k === screenIndex) cls = 'now';
  else if (k < screenIndex && k >= 0) cls = 'done';
  return (
    <button
      key={step.id}
      type="button"
      className={cls}
      onClick={() => onGo(k)}
      aria-label={`Step ${k + 1}: ${plain.steps[step.id]?.head ?? step.routeLabel}`}
    />
  );
}

export function TopBarV2({ walkthrough, plain, flow, screenIndex, onGo, onOpenMap }: Props) {
  const pr = walkthrough.pr;
  const parts = (walkthrough.parts ?? []).filter((p) => p.stepIds.length > 0);
  const useParts = parts.length >= 2;

  const currentStep = screenIndex >= 0 && screenIndex < flow.length ? flow[screenIndex] : null;
  const currentChapter = currentStep ? plain.steps[currentStep.id]?.ch ?? null : null;
  const currentPartId = currentStep
    ? parts.find((p) => p.stepIds.includes(currentStep.id))?.id ?? null
    : null;

  const problemSteps = flow.filter((s) => plain.steps[s.id]?.ch === 'problem');
  const fixSteps = flow.filter((s) => plain.steps[s.id]?.ch === 'fix');
  const checkSteps = flow.filter((s) => plain.steps[s.id]?.ch === 'check');

  const partStepIds = new Set(parts.flatMap((p) => p.stepIds));
  const fixOutsideParts = fixSteps.filter((s) => !partStepIds.has(s.id));

  return (
    <header className="v2top">
      <BrandLink className="v2home" />
      <div className="v2pr">
        <b>{pr.repo}</b>
        <span> #{pr.number} · {pr.title}</span>
      </div>
      <div className="v2top-right">
        {onOpenMap && (
          <button type="button" className="map-btn" onClick={onOpenMap} title="How the pieces connect">
            Diagram
          </button>
        )}
        <nav className="v2chapters" aria-label="Progress">
          {problemSteps.length > 0 && (
            <div className={`v2ch${currentChapter === 'problem' ? ' on' : ''}`}>
              Problem
              <span className="v2dots">
                {problemSteps.map((s) => (
                  <Dot key={s.id} step={s} flow={flow} screenIndex={screenIndex} plain={plain} onGo={onGo} />
                ))}
              </span>
            </div>
          )}

          {useParts ? (
            <>
              {parts.map((part, i) => {
                const steps = part.stepIds
                  .map((id) => flow.find((s) => s.id === id))
                  .filter((s): s is Step => !!s);
                if (steps.length === 0) return null;
                return (
                  <div className={`v2ch${currentPartId === part.id ? ' on' : ''}`} key={part.id}>
                    Part {i + 1}
                    <span className="v2part-title">{part.title}</span>
                    <span className="v2dots">
                      {steps.map((s) => (
                        <Dot key={s.id} step={s} flow={flow} screenIndex={screenIndex} plain={plain} onGo={onGo} />
                      ))}
                    </span>
                  </div>
                );
              })}
              {fixOutsideParts.length > 0 && (
                <div className={`v2ch${currentChapter === 'fix' && !currentPartId ? ' on' : ''}`}>
                  Fix
                  <span className="v2dots">
                    {fixOutsideParts.map((s) => (
                      <Dot key={s.id} step={s} flow={flow} screenIndex={screenIndex} plain={plain} onGo={onGo} />
                    ))}
                  </span>
                </div>
              )}
            </>
          ) : (
            fixSteps.length > 0 && (
              <div className={`v2ch${currentChapter === 'fix' ? ' on' : ''}`}>
                Fix
                <span className="v2dots">
                  {fixSteps.map((s) => (
                    <Dot key={s.id} step={s} flow={flow} screenIndex={screenIndex} plain={plain} onGo={onGo} />
                  ))}
                </span>
              </div>
            )
          )}

          {checkSteps.length > 0 && (
            <div className={`v2ch${currentChapter === 'check' ? ' on' : ''}`}>
              Try it
              <span className="v2dots">
                {checkSteps.map((s) => (
                  <Dot key={s.id} step={s} flow={flow} screenIndex={screenIndex} plain={plain} onGo={onGo} />
                ))}
              </span>
            </div>
          )}
        </nav>
      </div>
    </header>
  );
}
