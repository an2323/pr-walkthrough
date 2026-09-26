import type { OpenQuestion, Step } from '@pr-walkthrough/shared';

function md(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/`([^`]+)`/g, '<code>$1</code>');
}

interface Props {
  questions: OpenQuestion[];
  steps: Step[];
}

export function QuestionsPanel({ questions, steps }: Props) {
  return (
    <div className="panel">
      <h4>Questions for the author</h4>
      {questions.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: '14px' }}>No open questions.</p>
      ) : (
        questions.map((q) => {
          const stepIndex = steps.findIndex((s) => s.id === q.stepId);
          return (
            <div key={q.id} className="q" style={{ marginTop: 0, marginBottom: 8 }}>
              <p dangerouslySetInnerHTML={{ __html: md(q.question) }} />
              <small>
                Step {stepIndex + 1} · <span dangerouslySetInnerHTML={{ __html: md(q.why) }} />
              </small>
            </div>
          );
        })
      )}
    </div>
  );
}
