import type { Step, OpenQuestion } from '@pr-walkthrough/shared';
import { Chip } from './Chip';
import { CodeBlockView } from './CodeBlockView';
import { TracesView } from './TracesView';
import './StepView.css';

const KIND_LABEL: Record<string, string> = {
  symptom: 'Symptom',
  cause: 'Cause',
  constraint: 'Constraint',
  data_origin: 'Where the data lives',
  decision: 'Key decision',
  change: 'Change',
  alternative_rejected: 'Rejected alternative',
  dead_end: 'Dead end',
  open_question: 'Open question',
  verification: 'Verification',
};

/** Render backtick inline code in a string. Returns HTML string. */
function md(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/`([^`]+)`/g, '<code>$1</code>');
}

interface Props {
  step: Step;
  stepNumber: number;
  openQuestions: OpenQuestion[];
  onSpeak: () => void;
}

export function StepView({ step, stepNumber, openQuestions, onSpeak }: Props) {
  const stepQuestions = openQuestions.filter((q) => q.stepId === step.id);
  const notes = [
    ...(step.notes ?? []).map((n) => ({ text: n, prefix: '' })),
    ...(step.skipped ?? []).map((n) => ({ text: n, prefix: 'Skipped: ' })),
  ];

  return (
    <section className="step" aria-live="polite">
      {/* Header */}
      <div className="shead">
        <h2>{stepNumber}. {step.title}</h2>
        <Chip tag={step.tag} />
        <span className="kind">{KIND_LABEL[step.kind] ?? step.kind}</span>
      </div>

      {/* Narration */}
      <div className="voice">
        <button
          className="play"
          id="play"
          aria-label="Read this step aloud"
          onClick={onSpeak}
        >
          ▶
        </button>
        <p>{step.narration}</p>
      </div>

      {/* Beats */}
      {step.beats.map((beat, k) => (
        <div key={k} className="beat">
          <h3>
            <span className="bn">{k + 1}</span>
            {beat.heading}
          </h3>
          <p dangerouslySetInnerHTML={{ __html: md(beat.text) }} />
          {(beat.code ?? []).map((block, bi) => (
            <CodeBlockView key={bi} block={block} />
          ))}
          {beat.traces && <TracesView traces={beat.traces} />}
        </div>
      ))}

      {/* Notes */}
      {notes.length > 0 && (
        <div className="notes">
          {notes.map((n, i) => (
            <div key={i} dangerouslySetInnerHTML={{ __html: n.prefix + md(n.text) }} />
          ))}
        </div>
      )}

      {/* Inline questions for this step */}
      {stepQuestions.map((q) => (
        <div key={q.id} className="q">
          <b>Ask the author</b> <Chip tag={q.tag} />
          <p dangerouslySetInnerHTML={{ __html: md(q.question) }} />
          <small dangerouslySetInnerHTML={{ __html: md(q.why) }} />
        </div>
      ))}

      {/* Sources */}
      <div className="src">
        Sources:{' '}
        {step.sources
          .map((x) => `${x.type.replace(/_/g, ' ')} — ${x.ref}`)
          .join('; ')}
      </div>
    </section>
  );
}
