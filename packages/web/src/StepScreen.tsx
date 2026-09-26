/**
 * StepScreen — one screen per non-minor step.
 * Eyebrow, h1, say, visual, code (optionally hidden behind "Show the code change"),
 * check card, ask row (open question), "How the analysis got here" link.
 */

import { useState } from 'react';
import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';
import { VisualBlock } from './VisualBlock';
import { CodeFold } from './CodeFold';

const CH_LABEL: Record<string, string> = {
  problem: 'Problem',
  fix: 'Fix',
  check: 'Try it',
};

const SOURCE_LABEL: Record<string, string> = {
  commit_history: 'from the commit history',
  inferred: 'our reading of the code',
  unverified: 'not run yet',
};

interface Props {
  step: Step;
  stepIndex: number; // 1-based position in flow
  stepInChapter: number; // 1-based position within the chapter
  chapterTotal: number;
  walkthrough: Walkthrough;
  plain: PlainData;
  checked: boolean;
  onCheck: (v: boolean) => void;
  asked: boolean;
  onAsk: () => void;
  verifiedItems: Record<number, boolean>;
  onVerify: (k: number, v: boolean) => void;
  onOpenDrawer: () => void;
}

export function StepScreen({
  step,
  stepIndex,
  stepInChapter,
  chapterTotal,
  walkthrough,
  plain,
  checked,
  onCheck,
  asked,
  onAsk,
  verifiedItems,
  onVerify,
  onOpenDrawer,
}: Props) {
  const p = plain.steps[step.id];
  const pr = walkthrough.pr;
  const [showCode, setShowCode] = useState(false);

  if (!p) return null;

  const ch = CH_LABEL[p.ch] ?? p.ch;
  const question = walkthrough.openQuestions.find((q) => q.stepId === step.id);
  const questionText = question?.short ?? question?.question;

  // Find the first code block from the step's beats (for "Show the code change")
  const firstCodeBeat = step.beats.find((b) => b.code && b.code.length > 0);
  const firstCode = firstCodeBeat?.code?.[0];

  return (
    <div className="v2card">
      {/* Eyebrow */}
      <div className="v2eyebrow">
        <b>{ch}</b>
        {' · '}{stepInChapter} of {chapterTotal}
        {p.detour && (
          <>{' · '}<span className="detour">a path the author tried and replaced</span></>
        )}
        {step.tag !== 'fact' && SOURCE_LABEL[step.tag] && (
          <>{' · '}<span className="src">{SOURCE_LABEL[step.tag]}</span></>
        )}
      </div>

      {/* Headline */}
      <h1 className={`v2h1${p.detour ? ' detour' : ''}`}
        style={p.detour ? { textDecoration: 'line-through' } : undefined}
      >
        {p.head}
      </h1>

      {/* Say */}
      <p className="v2say">{p.say}</p>

      {/* Visual */}
      {p.visual && (
        <VisualBlock
          visual={p.visual}
          walkthrough={walkthrough}
          step={step}
          stepIndex={stepIndex}
          edgesPlain={plain.edges}
          verifiedItems={verifiedItems}
          onVerify={onVerify}
        />
      )}

      {/* Code block */}
      {firstCode && !p.visual && (
        <div className="visual">
          <CodeFold
            block={firstCode}
            prRepo={pr.repo}
            baseSha={pr.baseSha}
            headSha={pr.headSha}
            prUrl={pr.url}
          />
        </div>
      )}

      {/* Code behind "Show the code change" when there's also a visual */}
      {firstCode && p.visual && (
        showCode ? (
          <div className="visual">
            <CodeFold
              block={firstCode}
              prRepo={pr.repo}
              baseSha={pr.baseSha}
              headSha={pr.headSha}
              prUrl={pr.url}
            />
          </div>
        ) : (
          <button className="more" onClick={() => setShowCode(true)}>
            Show the code change
          </button>
        )
      )}

      {/* Check card */}
      {p.check && (
        <label className={`check${checked ? ' done' : ''}`}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheck(e.target.checked)}
          />
          <span className="lbl">
            <span className="k">Your check</span>
            <span>{p.check}</span>
          </span>
        </label>
      )}

      {/* Open question */}
      {questionText && (
        <div className="ask">
          <span className="q">
            <b>Ask?</b>
            <span>{questionText}</span>
          </span>
          <button
            className="chip"
            aria-pressed={asked}
            onClick={onAsk}
          >
            {asked ? 'Added' : 'Add to review'}
          </button>
        </div>
      )}

      {/* Details drawer link */}
      <div className="quiet">
        <button className="link-btn" onClick={onOpenDrawer}>
          How the analysis got here
        </button>
      </div>
    </div>
  );
}
