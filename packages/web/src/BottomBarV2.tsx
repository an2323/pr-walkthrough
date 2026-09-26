/**
 * BottomBarV2 — Back | Listen | Next bottom bar.
 */

interface Props {
  screenIndex: number; // -1 = start
  total: number; // flow.length
  isPlaying: boolean;
  onBack: () => void;
  onNext: () => void;
  onListen: () => void;
}

export function BottomBarV2({ screenIndex, total, isPlaying, onBack, onNext, onListen }: Props) {
  const isStart = screenIndex < 0;
  const isLast = screenIndex === total - 1;
  const isSummary = screenIndex >= total;

  let nextLabel: string;
  if (isStart) nextLabel = 'Start →';
  else if (isLast) nextLabel = 'Finish review →';
  else if (isSummary) nextLabel = '← Back to start';
  else nextLabel = 'Next →';

  const listenLabel = isPlaying
    ? 'Listening… tap to stop'
    : screenIndex >= 0 && screenIndex < total
    ? 'Listen to this step'
    : 'Listen to the whole walkthrough';

  return (
    <footer className="v2bar">
      <button
        className="v2btn"
        disabled={isStart}
        onClick={onBack}
        aria-label="Back"
      >
        ← Back
      </button>

      <button
        className={`listen${isPlaying ? ' on' : ''}`}
        onClick={onListen}
        aria-label={listenLabel}
      >
        <span className="ic">
          {isPlaying ? (
            <span className="eq">
              <i /><i /><i />
            </span>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2 L14 8 L4 14 z" fill="currentColor" />
            </svg>
          )}
        </span>
        <span className="t">{listenLabel}</span>
      </button>

      <button
        className="v2btn primary"
        onClick={onNext}
      >
        {nextLabel}
      </button>
    </footer>
  );
}
