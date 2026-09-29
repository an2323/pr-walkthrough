/**
 * BottomBarV2 — Back | Play + mode menu | Next.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { ListenMode, ListenStatus } from './useWalkthroughNarration';

interface Props {
  screenIndex: number; // -1 = start
  total: number; // flow.length
  status: ListenStatus;
  mode: ListenMode;
  /** Done screen has a short outro (diagram cue). */
  hasOutro?: boolean;
  onBack: () => void;
  onNext: () => void;
  onListen: () => void;
  onModeChange: (mode: ListenMode) => void;
}

const MODE_OPTIONS: { id: ListenMode; label: string; hint: string }[] = [
  { id: 'autoplay', label: 'Auto', hint: 'Read and advance' },
  { id: 'follow', label: 'Follow', hint: 'Read each new step' },
  { id: 'off', label: 'Off', hint: 'No sound' },
];

function modeLabel(mode: ListenMode): string {
  return MODE_OPTIONS.find((o) => o.id === mode)?.label ?? 'Auto';
}

export function BottomBarV2({
  screenIndex,
  total,
  status,
  mode,
  hasOutro = false,
  onBack,
  onNext,
  onListen,
  onModeChange,
}: Props) {
  const isStart = screenIndex < 0;
  const isLast = screenIndex === total - 1;
  const isSummary = screenIndex >= total;
  const muted = mode === 'off';
  const isPlaying = status === 'playing';
  const isPaused = status === 'paused';

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  let nextLabel: string;
  if (isStart) nextLabel = 'Start →';
  else if (isLast) nextLabel = 'Finish review →';
  else if (isSummary) nextLabel = '← Back to start';
  else nextLabel = 'Next →';

  // "Whole walkthrough" only at the start or first step; elsewhere Play / Resume.
  // Done screen: no restart-from-beginning.
  let listenLabel: string;
  if (muted) listenLabel = 'Sound off';
  else if (isPlaying) listenLabel = 'Pause';
  else if (isPaused) listenLabel = 'Resume';
  else if (isSummary) listenLabel = 'Play';
  else if (isStart || screenIndex === 0) listenLabel = 'Listen to the whole walkthrough';
  else listenLabel = 'Play';

  const listenDisabled =
    muted || (isSummary && !hasOutro && !isPlaying && !isPaused);

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

      <div className="listen-cluster">
        <button
          className={`listen${isPlaying || isPaused ? ' on' : ''}${muted || listenDisabled ? ' muted' : ''}`}
          onClick={onListen}
          disabled={listenDisabled}
          aria-label={listenLabel}
        >
          <span className="ic">
            {isPlaying ? (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="3" y="2" width="4" height="12" rx="1" fill="currentColor" />
                <rect x="9" y="2" width="4" height="12" rx="1" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 2 L14 8 L4 14 z" fill="currentColor" />
              </svg>
            )}
          </span>
          <span className="t">{listenLabel}</span>
        </button>

        <div className="listen-mode-wrap" ref={menuRef}>
          <button
            type="button"
            className={`listen-mode-btn${menuOpen ? ' open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {modeLabel(mode)}
            <span className="listen-mode-caret" aria-hidden="true">▾</span>
          </button>
          {menuOpen && (
            <div className="listen-mode-menu" id={menuId} role="menu">
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === opt.id}
                  className={mode === opt.id ? 'active' : undefined}
                  onClick={() => {
                    onModeChange(opt.id);
                    setMenuOpen(false);
                  }}
                >
                  <span className="listen-mode-opt-label">{opt.label}</span>
                  <span className="listen-mode-opt-hint">{opt.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <button
        className="v2btn primary"
        onClick={onNext}
      >
        {nextLabel}
      </button>
    </footer>
  );
}
