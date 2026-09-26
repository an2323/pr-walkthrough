import { useEffect } from 'react';
import './StepNav.css';

interface Props {
  activeIndex: number;
  total: number;
  playAll: boolean;
  onPrev: () => void;
  onNext: () => void;
  onPlayAllChange: (checked: boolean) => void;
}

export function StepNav({ activeIndex, total, playAll, onPrev, onNext, onPlayAllChange }: Props) {
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'ArrowRight') onNext();
      if (e.key === 'ArrowLeft') onPrev();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onNext, onPrev]);

  return (
    <div className="nav">
      <button onClick={onPrev} disabled={activeIndex === 0}>Previous</button>
      <button onClick={onNext} disabled={activeIndex === total - 1}>Next</button>
      <label className="nav__play-label">
        <input
          type="checkbox"
          checked={playAll}
          onChange={(e) => onPlayAllChange(e.target.checked)}
        />
        Play all steps aloud
      </label>
      <span className="hint">Arrow keys move between steps</span>
    </div>
  );
}
