/**
 * Walkthrough narration: Autoplay / Follow / Off, with pause & resume.
 *
 * - Autoplay: play advances through steps, then a short Done outro when present.
 * - Follow: narrate each step when the screen changes; no auto-advance.
 * - Off: mute — never speak.
 *
 * Pause keeps a resume cursor (step + sentence + MP3 currentTime).
 * Manual navigation clears the cursor; if audio was playing (or Follow),
 * narration restarts on the new step (or Done outro).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Step } from '@pr-walkthrough/shared';
import { audioUrl } from './staticMode';
import { splitSentences } from './symptomHighlight';

export type ListenMode = 'autoplay' | 'follow' | 'off';
export type ListenStatus = 'idle' | 'playing' | 'paused';

export type NarrationCue = { stepId: string; sentence: number };

const MODE_KEY = 'pr-wt-listen-mode';

const synth =
  typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null;


/** Short Done-screen cue — only when a diagram is on screen. */
export const OUTRO_STEP_ID = 'outro';
export const OUTRO_NARRATION = 'Take a look at the final diagram of the fix.';

export function buildOutroNarration(opts: { hasGraph: boolean }): string | null {
  if (!opts.hasGraph) return null;
  return OUTRO_NARRATION;
}

function readStoredMode(): ListenMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'autoplay' || v === 'follow' || v === 'off') return v;
  } catch {
    /* ignore */
  }
  return 'autoplay';
}

interface ResumeCursor {
  stepIndex: number;
  sentenceIndex: number;
  audioTimeSec: number;
}

interface SpeakOpts {
  fromSentence?: number;
  seekSec?: number;
  autoAdvance: boolean;
}

export interface UseWalkthroughNarrationArgs {
  flow: Step[];
  endIndex: number;
  screenIndex: number;
  setScreenIndex: (i: number) => void;
  language: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** Spoken on the Done screen (Web Speech); null = silence there. */
  outroNarration: string | null;
}

export function useWalkthroughNarration({
  flow,
  endIndex,
  screenIndex,
  setScreenIndex,
  language,
  owner,
  repo,
  prNumber,
  outroNarration,
}: UseWalkthroughNarrationArgs) {
  const [mode, setModeState] = useState<ListenMode>(() => readStoredMode());
  const [status, setStatus] = useState<ListenStatus>('idle');
  const [narrationCue, setNarrationCue] = useState<NarrationCue | null>(null);

  const tokenRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cursorRef = useRef<ResumeCursor | null>(null);
  const statusRef = useRef<ListenStatus>('idle');
  const modeRef = useRef<ListenMode>(mode);
  const screenIndexRef = useRef(screenIndex);
  const flowRef = useRef(flow);
  const outroRef = useRef(outroNarration);
  const endIndexRef = useRef(endIndex);

  statusRef.current = status;
  modeRef.current = mode;
  screenIndexRef.current = screenIndex;
  flowRef.current = flow;
  outroRef.current = outroNarration;
  endIndexRef.current = endIndex;

  const hardStop = useCallback((opts?: { keepCue?: boolean }) => {
    tokenRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      audioRef.current?.pause();
      audioRef.current = null;
    } catch {
      /* ignore */
    }
    try {
      synth?.cancel();
    } catch {
      /* ignore */
    }
    cursorRef.current = null;
    if (!opts?.keepCue) setNarrationCue(null);
    statusRef.current = 'idle';
    setStatus('idle');
  }, []);

  const setMode = useCallback(
    (next: ListenMode) => {
      setModeState(next);
      modeRef.current = next;
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch {
        /* ignore */
      }
      if (next === 'off') hardStop();
    },
    [hardStop]
  );

  const playSentenceAudio = useCallback(
    (url: string, seekSec: number, token: number): Promise<'done' | 'cancelled'> =>
      new Promise((resolve) => {
        if (token !== tokenRef.current) {
          resolve('cancelled');
          return;
        }
        const audio = new Audio(url);
        audioRef.current = audio;
        const finish = (result: 'done' | 'cancelled') => {
          if (audioRef.current === audio) audioRef.current = null;
          resolve(result);
        };
        audio.onended = () => finish(token === tokenRef.current ? 'done' : 'cancelled');
        audio.onerror = () => finish(token === tokenRef.current ? 'done' : 'cancelled');
        const start = () => {
          if (token !== tokenRef.current) {
            finish('cancelled');
            return;
          }
          if (seekSec > 0 && Number.isFinite(seekSec)) {
            try {
              audio.currentTime = seekSec;
            } catch {
              /* ignore */
            }
          }
          audio.play().catch(() => finish('done'));
        };
        if (seekSec > 0) {
          audio.addEventListener('loadedmetadata', start, { once: true });
          audio.load();
        } else {
          start();
        }
      }),
    []
  );

  const speakFallback = useCallback(
    (text: string, lang: string, token: number): Promise<'done' | 'cancelled'> =>
      new Promise((resolve) => {
        if (token !== tokenRef.current) {
          resolve('cancelled');
          return;
        }
        if (!synth) {
          timerRef.current = setTimeout(() => {
            resolve(token === tokenRef.current ? 'done' : 'cancelled');
          }, text.split(/\s+/).length * 400);
          return;
        }
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        u.onend = () => resolve(token === tokenRef.current ? 'done' : 'cancelled');
        u.onerror = () => {
          timerRef.current = setTimeout(() => {
            resolve(token === tokenRef.current ? 'done' : 'cancelled');
          }, 2500);
        };
        synth.speak(u);
      }),
    []
  );

  const speakOutro = useCallback(
    async (opts: SpeakOpts, token: number) => {
      if (token !== tokenRef.current) return;
      const text = outroRef.current;
      const end = endIndexRef.current;
      if (!text) {
        statusRef.current = 'idle';
        setStatus('idle');
        setNarrationCue(null);
        return;
      }

      const sentences = splitSentences(text);
      let seek = opts.seekSec ?? 0;

      for (let i = opts.fromSentence ?? 0; i < sentences.length; i++) {
        if (token !== tokenRef.current) return;
        cursorRef.current = { stepIndex: end, sentenceIndex: i, audioTimeSec: 0 };
        setNarrationCue(null);

        const url = audioUrl(owner, repo, prNumber, OUTRO_STEP_ID, i);
        let usedApi = false;
        try {
          const probe = await fetch(url, { method: 'HEAD' });
          if (token !== tokenRef.current) return;
          if (probe.ok) {
            const result = await playSentenceAudio(url, seek, token);
            usedApi = true;
            seek = 0;
            if (result === 'cancelled') return;
          }
        } catch {
          /* fall through to Web Speech */
        }

        if (!usedApi) {
          seek = 0;
          const result = await speakFallback(sentences[i], language, token);
          if (result === 'cancelled') return;
        }
      }

      if (token !== tokenRef.current) return;
      cursorRef.current = null;
      statusRef.current = 'idle';
      setStatus('idle');
    },
    [language, owner, playSentenceAudio, prNumber, repo, speakFallback]
  );

  const speakStep = useCallback(
    async (idx: number, opts: SpeakOpts, token: number) => {
      if (token !== tokenRef.current) return;
      const step = flowRef.current[idx];
      if (!step) {
        statusRef.current = 'idle';
        setStatus('idle');
        setNarrationCue(null);
        return;
      }

      const sentences = splitSentences(step.narration ?? '');
      let seek = opts.seekSec ?? 0;

      for (let i = opts.fromSentence ?? 0; i < sentences.length; i++) {
        if (token !== tokenRef.current) return;

        cursorRef.current = { stepIndex: idx, sentenceIndex: i, audioTimeSec: 0 };
        setNarrationCue({ stepId: step.id, sentence: i });

        const url = audioUrl(owner, repo, prNumber, step.id, i);
        let usedApi = false;
        try {
          const probe = await fetch(url, { method: 'HEAD' });
          if (token !== tokenRef.current) return;
          if (probe.ok) {
            const result = await playSentenceAudio(url, seek, token);
            usedApi = true;
            seek = 0;
            if (result === 'cancelled') return;
          }
        } catch {
          /* fall through to Web Speech */
        }

        if (!usedApi) {
          seek = 0;
          const result = await speakFallback(sentences[i], language, token);
          if (result === 'cancelled') return;
        }
      }

      if (token !== tokenRef.current) return;
      setNarrationCue(null);
      cursorRef.current = null;

      if (opts.autoAdvance && idx < endIndex - 1) {
        const next = idx + 1;
        screenIndexRef.current = next;
        setScreenIndex(next);
        timerRef.current = setTimeout(() => {
          if (token !== tokenRef.current) return;
          void speakStep(next, { fromSentence: 0, seekSec: 0, autoAdvance: true }, token);
        }, 500);
      } else if (opts.autoAdvance && idx === endIndex - 1 && outroRef.current) {
        screenIndexRef.current = endIndex;
        setScreenIndex(endIndex);
        timerRef.current = setTimeout(() => {
          if (token !== tokenRef.current) return;
          void speakOutro({ fromSentence: 0, seekSec: 0, autoAdvance: false }, token);
        }, 500);
      } else {
        statusRef.current = 'idle';
        setStatus('idle');
      }
    },
    [
      endIndex,
      language,
      owner,
      playSentenceAudio,
      prNumber,
      repo,
      setScreenIndex,
      speakFallback,
      speakOutro,
    ]
  );

  const startAt = useCallback(
    (idx: number, opts: SpeakOpts) => {
      if (modeRef.current === 'off') return;
      if (timerRef.current) clearTimeout(timerRef.current);
      try {
        audioRef.current?.pause();
        audioRef.current = null;
      } catch {
        /* ignore */
      }
      try {
        synth?.cancel();
      } catch {
        /* ignore */
      }

      // Start screen → begin the walkthrough at step 0.
      let startIdx = idx;
      if (startIdx < 0) {
        startIdx = 0;
        screenIndexRef.current = 0;
        setScreenIndex(0);
      } else if (startIdx >= endIndex) {
        // Done — short outro only; never jump back to step 0.
        if (!outroRef.current) return;
        const token = ++tokenRef.current;
        statusRef.current = 'playing';
        setStatus('playing');
        void speakOutro(opts, token);
        return;
      }

      const token = ++tokenRef.current;
      statusRef.current = 'playing';
      setStatus('playing');
      void speakStep(startIdx, opts, token);
    },
    [endIndex, setScreenIndex, speakOutro, speakStep]
  );

  const pause = useCallback(() => {
    if (statusRef.current !== 'playing') return;
    const audio = audioRef.current;
    const time = audio && !Number.isNaN(audio.currentTime) ? audio.currentTime : 0;
    if (cursorRef.current) {
      cursorRef.current = { ...cursorRef.current, audioTimeSec: time };
    }
    tokenRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      audio?.pause();
      audioRef.current = null;
    } catch {
      /* ignore */
    }
    try {
      synth?.cancel();
    } catch {
      /* ignore */
    }
    statusRef.current = 'paused';
    setStatus('paused');
  }, []);

  const resume = useCallback(() => {
    if (statusRef.current !== 'paused') return;
    const c = cursorRef.current;
    if (!c) {
      startAt(screenIndexRef.current, {
        fromSentence: 0,
        seekSec: 0,
        autoAdvance: modeRef.current === 'autoplay',
      });
      return;
    }
    startAt(c.stepIndex, {
      fromSentence: c.sentenceIndex,
      seekSec: c.audioTimeSec,
      autoAdvance: modeRef.current === 'autoplay',
    });
  }, [startAt]);

  const play = useCallback(() => {
    if (modeRef.current === 'off') return;
    cursorRef.current = null;
    startAt(screenIndexRef.current, {
      fromSentence: 0,
      seekSec: 0,
      autoAdvance: modeRef.current === 'autoplay',
    });
  }, [startAt]);

  const toggle = useCallback(() => {
    if (modeRef.current === 'off') return;
    if (statusRef.current === 'playing') pause();
    else if (statusRef.current === 'paused') resume();
    else play();
  }, [pause, play, resume]);

  /**
   * User-driven screen change (Back / Next / dots / arrows).
   * Clears resume cursor. Restarts narration when was playing, or always in Follow.
   */
  const onManualNavigate = useCallback(
    (nextIndex: number) => {
      const wasPlaying = statusRef.current === 'playing';
      const m = modeRef.current;

      hardStop();

      if (m === 'off') return;

      const onStep = nextIndex >= 0 && nextIndex < endIndex;
      const onDone = nextIndex >= endIndex && !!outroRef.current;
      if (!onStep && !onDone) return;

      if (wasPlaying || m === 'follow') {
        startAt(onDone ? endIndex : nextIndex, {
          fromSentence: 0,
          seekSec: 0,
          autoAdvance: m === 'autoplay',
        });
      }
    },
    [endIndex, hardStop, startAt]
  );

  useEffect(() => () => hardStop(), [hardStop]);

  return {
    mode,
    setMode,
    status,
    narrationCue,
    isPlaying: status === 'playing',
    isPaused: status === 'paused',
    hasOutro: !!outroNarration,
    toggle,
    play,
    pause,
    resume,
    stop: hardStop,
    onManualNavigate,
  };
}
