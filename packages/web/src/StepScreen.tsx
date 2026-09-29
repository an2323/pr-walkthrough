/**
 * StepScreen — one screen per non-minor step.
 * Eyebrow, h1, say, visual, code (always shown when present),
 * check card (SHOW_CHECKS), ask row (open question), "How the analysis got here" link.
 */

import { useState } from 'react';
import type { Walkthrough, Step } from '@pr-walkthrough/shared';
import type { PlainData } from './v2types';
import { VisualBlock } from './VisualBlock';
import { CodeFold } from './CodeFold';
import { SHOW_CHECKS } from './features';
import { QuestionComposer, type AskResult } from './review';
import { pickAskTarget, stepCodeBlocks } from './pickAskTarget';

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
  /** When set (e.g. Part 1 · Stacking), replaces the chapter name in the eyebrow. */
  chapterLabel?: string;
  walkthrough: Walkthrough;
  plain: PlainData;
  checked: boolean;
  onCheck: (v: boolean) => void;
  askResult?: AskResult;
  onAskDone: (result: AskResult) => void;
  verifiedItems: Record<number, boolean>;
  onVerify: (k: number, v: boolean) => void;
  onOpenDrawer: () => void;
  /** Index of the narration sentence currently playing, or null when silent. */
  narrationSentence?: number | null;
}

export function StepScreen({
  step,
  stepIndex,
  stepInChapter,
  chapterTotal,
  chapterLabel,
  walkthrough,
  plain,
  checked,
  onCheck,
  askResult,
  onAskDone,
  verifiedItems,
  onVerify,
  onOpenDrawer,
  narrationSentence = null,
}: Props) {
  const p = plain.steps[step.id];
  const pr = walkthrough.pr;
  const [askSeed, setAskSeed] = useState<{
    blockIndex: number;
    lineIndex: number;
    text: string;
  } | null>(null);
  const [generalCompose, setGeneralCompose] = useState(false);

  if (!p) return null;

  const ch = chapterLabel ?? CH_LABEL[p.ch] ?? p.ch;
  const question = walkthrough.openQuestions.find((q) => q.stepId === step.id);
  const questionText = question?.short ?? question?.question;
  const askTarget = question ? pickAskTarget(step, question) : null;

  // Symptom steps describe what the user sees; their "code" is background context, not a change.
  const codeBlocks = stepCodeBlocks(step);
  const hasCode = codeBlocks.length > 0;

  function startAsk() {
    if (!question) return;
    const target = pickAskTarget(step, question);
    if (target) {
      setGeneralCompose(false);
      setAskSeed({
        blockIndex: target.blockIndex,
        lineIndex: target.lineIndex,
        text: question.question,
      });
    } else {
      setAskSeed(null);
      setGeneralCompose(true);
    }
  }

  function clearAskCompose() {
    setAskSeed(null);
    setGeneralCompose(false);
  }

  const lineHint = askTarget
    ? `${askTarget.block.file.split('/').pop() ?? askTarget.block.file}${
        askTarget.block.lines[askTarget.lineIndex]?.n != null
          ? `:${askTarget.block.lines[askTarget.lineIndex].n}`
          : ''
      }`
    : null;

  const story = (
    <div className="v2step-story">
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

      <h1 className={`v2h1${p.detour ? ' detour' : ''}`}
        style={p.detour ? { textDecoration: 'line-through' } : undefined}
      >
        {p.head}
      </h1>

      <p className="v2say">{p.say}</p>

      {p.visual && (
        <VisualBlock
          visual={p.visual}
          walkthrough={walkthrough}
          step={step}
          stepIndex={stepIndex}
          edgesPlain={plain.edges}
          verifiedItems={verifiedItems}
          onVerify={onVerify}
          narrationSentence={narrationSentence}
        />
      )}

      {SHOW_CHECKS && p.check && (
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

      {question && questionText && (
        <div className="ask-block">
          <div className={`ask${askResult && !askSeed && !generalCompose ? ' settled' : ''}`}>
            <span className="q">
              <b>Ask?</b>
              <span>{questionText}</span>
            </span>
            {!askSeed && !generalCompose && !askResult && (
              <button className="chip" type="button" onClick={startAsk}>
                Ask
              </button>
            )}
            {(askSeed || generalCompose) && !askResult && (
              <span className="ask-status">
                {askSeed ? `On ${lineHint} →` : 'Confirm below →'}
              </span>
            )}
            {!askSeed && !generalCompose && askResult?.kind === 'posted' && (
              <span className="ask-status">
                Posted{askResult.file ? ` on ${askResult.file.split('/').pop()}` : ''}{' '}
                <a href={askResult.url} target="_blank" rel="noopener noreferrer">view ↗</a>
                {' · '}
                <button type="button" className="link-btn" onClick={startAsk}>
                  Ask again
                </button>
              </span>
            )}
            {!askSeed && !generalCompose && askResult?.kind === 'copied' && (
              <span className="ask-status">
                Copied{askResult.file ? ` (${askResult.file.split('/').pop()})` : ''} ·{' '}
                <button type="button" className="link-btn" onClick={startAsk}>
                  Ask again
                </button>
              </span>
            )}
          </div>
          {generalCompose && (
            <QuestionComposer
              initialText={question.question}
              onCancel={clearAskCompose}
              onDone={(result) => {
                onAskDone(result);
                clearAskCompose();
              }}
            />
          )}
        </div>
      )}

      <div className="quiet">
        <button className="link-btn" onClick={onOpenDrawer}>
          How the analysis got here
        </button>
      </div>
    </div>
  );

  if (!hasCode) {
    return <div className="v2step">{story}</div>;
  }

  return (
    <div className="v2step has-code">
      {story}
      <div className="v2step-code">
        <div className="visual code-stack">
          {codeBlocks.map((block, i) => (
            <CodeFold
              key={i}
              block={block}
              prRepo={pr.repo}
              baseSha={pr.baseSha}
              headSha={pr.headSha}
              prUrl={pr.url}
              askSeed={
                askSeed?.blockIndex === i
                  ? { lineIndex: askSeed.lineIndex, text: askSeed.text }
                  : null
              }
              onAskSettled={(result) => {
                onAskDone(result);
                clearAskCompose();
              }}
              onAskCancel={clearAskCompose}
            />
          ))}
        </div>
        <div className="code-legend">
          <span className="lg-item"><span className="lg-dot lg-add" />added</span>
          <span className="lg-item"><span className="lg-dot lg-del" />removed</span>
          <span className="lg-item"><span className="lg-dot lg-focus" />look here</span>
        </div>
      </div>
    </div>
  );
}
