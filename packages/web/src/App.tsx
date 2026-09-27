import { useState, useEffect, useCallback, useRef } from 'react';
import type { Step } from '@pr-walkthrough/shared';
import { useWalkthrough } from './useWalkthrough';
import { buildPlainData } from './buildPlain';
import { TopBarV2 } from './TopBarV2';
import { BottomBarV2 } from './BottomBarV2';
import { StartScreen } from './StartScreen';
import { StepScreen } from './StepScreen';
import { SummaryScreen } from './SummaryScreen';
import { Drawer } from './Drawer';
import { LandingPage } from './LandingPage';
import { ProgressScreen } from './ProgressScreen';
import { SHOW_TRY_IT } from './features';
import { ReviewProvider } from './review';
import { audioUrl } from './staticMode';
import { MapModal } from './MapModal';
import './styles.css';
import './v2.css';

// -----------------------------------------------------------------
// Voice helpers
// -----------------------------------------------------------------
const synth = typeof window !== 'undefined' && 'speechSynthesis' in window
  ? window.speechSynthesis
  : null;

/** Split narration into sentences — mirrors the server's splitSentences(). */
function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.?!])\s+/);
  return parts.map(s => s.trim()).filter(s => s.length > 0);
}

export default function App() {
  const walkthroughState = useWalkthrough();

  // ---- Screen state ----
  // -1 = start screen, 0..flow.length-1 = step screens, flow.length = summary
  const [screenIndex, setScreenIndex] = useState(-1);

  // ---- Check / ask / verify state ----
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [asks, setAsks] = useState<Record<string, boolean>>({});
  const [verifiedItems, setVerifiedItems] = useState<Record<number, boolean>>({});

  // ---- Drawer state ----
  const [drawerStepId, setDrawerStepId] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapFocusNode, setMapFocusNode] = useState<string | undefined>(undefined);

  // ---- Voice state ----
  const [isPlaying, setIsPlaying] = useState(false);
  /** Which narration sentence is currently speaking (drives symptom-card highlights). */
  const [narrationCue, setNarrationCue] = useState<{ stepId: string; sentence: number } | null>(null);
  const tokenRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ---- Route: /:owner/:repo/:number/progress — live or replayed analysis (ST6c) ----
  // Checked ahead of the walkthrough-viewer states below; useWalkthrough()'s own
  // pathname match requires exactly 3 segments, so it never fires for this 4-segment
  // route and stays 'idle' — no unwanted /api/walkthroughs fetch happens here.
  const progressMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/(\d+)\/progress\/?$/);
  if (progressMatch) {
    const [, owner, repo, numberStr] = progressMatch;
    return <ProgressScreen owner={owner} repo={repo} number={parseInt(numberStr, 10)} />;
  }

  // ---- Derived data ----
  if (walkthroughState.status === 'idle') {
    return <LandingPage />;
  }

  if (walkthroughState.status === 'loading') {
    return <div style={{ padding: 40 }}>Loading…</div>;
  }

  if (walkthroughState.status === 'error') {
    return (
      <div style={{ padding: 40, color: 'var(--bad)' }}>
        Error: {walkthroughState.message}
      </div>
    );
  }

  const { data: walkthrough } = walkthroughState;
  const plain = buildPlainData(walkthrough);

  // flow = non-minor steps only (and no "Try it" chapter while it's switched off)
  const flow: Step[] = walkthrough.steps.filter(
    (s) =>
      !plain.steps[s.id]?.skip &&
      !plain.steps[s.id]?.minor &&
      (SHOW_TRY_IT || plain.steps[s.id]?.ch !== 'check')
  );
  const minors: Step[] = walkthrough.steps.filter(
    (s) => !!plain.steps[s.id]?.minor && !plain.steps[s.id]?.skip
  );

  const END = flow.length; // summary screen index

  return (
    <AppInner
      walkthroughState={walkthroughState}
      plain={plain}
      flow={flow}
      minors={minors}
      screenIndex={screenIndex}
      setScreenIndex={setScreenIndex}
      checks={checks}
      setChecks={setChecks}
      asks={asks}
      setAsks={setAsks}
      verifiedItems={verifiedItems}
      setVerifiedItems={setVerifiedItems}
      drawerStepId={drawerStepId}
      setDrawerStepId={setDrawerStepId}
      mapOpen={mapOpen}
      setMapOpen={setMapOpen}
      mapFocusNode={mapFocusNode}
      setMapFocusNode={setMapFocusNode}
      isPlaying={isPlaying}
      setIsPlaying={setIsPlaying}
      narrationCue={narrationCue}
      setNarrationCue={setNarrationCue}
      tokenRef={tokenRef}
      timerRef={timerRef}
      audioRef={audioRef}
      synth={synth}
      END={END}
    />
  );
}

// -----------------------------------------------------------------
// Inner component — receives all derived state so hooks run unconditionally
// -----------------------------------------------------------------
interface InnerProps {
  walkthroughState: { status: 'ok'; data: import('@pr-walkthrough/shared').Walkthrough };
  plain: ReturnType<typeof buildPlainData>;
  flow: Step[];
  minors: Step[];
  screenIndex: number;
  setScreenIndex: (i: number) => void;
  checks: Record<string, boolean>;
  setChecks: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  asks: Record<string, boolean>;
  setAsks: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  verifiedItems: Record<number, boolean>;
  setVerifiedItems: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  drawerStepId: string | null;
  setDrawerStepId: (id: string | null) => void;
  mapOpen: boolean;
  setMapOpen: (v: boolean) => void;
  mapFocusNode: string | undefined;
  setMapFocusNode: (v: string | undefined) => void;
  isPlaying: boolean;
  setIsPlaying: (v: boolean) => void;
  narrationCue: { stepId: string; sentence: number } | null;
  setNarrationCue: (v: { stepId: string; sentence: number } | null) => void;
  tokenRef: React.MutableRefObject<number>;
  timerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  audioRef: React.MutableRefObject<HTMLAudioElement | null>;
  synth: SpeechSynthesis | null;
  END: number;
}

function AppInner({
  walkthroughState,
  plain,
  flow,
  minors,
  screenIndex,
  setScreenIndex,
  checks,
  setChecks,
  asks,
  setAsks,
  verifiedItems,
  setVerifiedItems,
  drawerStepId,
  setDrawerStepId,
  mapOpen,
  setMapOpen,
  mapFocusNode,
  setMapFocusNode,
  isPlaying,
  setIsPlaying,
  narrationCue,
  setNarrationCue,
  tokenRef,
  timerRef,
  audioRef,
  synth,
  END,
}: InnerProps) {
  const walkthrough = walkthroughState.data;

  const screenIndexRef = useRef(screenIndex);
  screenIndexRef.current = screenIndex;

  const stopListen = useCallback(() => {
    tokenRef.current++;
    setIsPlaying(false);
    setNarrationCue(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      audioRef.current?.pause();
      audioRef.current = null;
    } catch {}
    try { synth?.cancel(); } catch {}
  }, [synth, audioRef, setIsPlaying, setNarrationCue, tokenRef, timerRef]);

  const go = useCallback((i: number, keepAudio = false) => {
    const clamped = Math.max(-1, Math.min(END, i));
    if (!keepAudio) stopListen();
    screenIndexRef.current = clamped;
    setScreenIndex(clamped);
  }, [END, stopListen, setScreenIndex]);

  const listen = useCallback((all = false) => {
    let startIdx = screenIndexRef.current;
    if (startIdx < 0 || startIdx >= END) {
      startIdx = 0;
      screenIndexRef.current = 0;
      setScreenIndex(0);
    }
    setIsPlaying(true);
    const t = ++tokenRef.current;

    // Play a single sentence via <audio> API; returns a Promise that resolves when done.
    const playSentenceAudio = (url: string): Promise<void> =>
      new Promise((resolve) => {
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => { audioRef.current = null; resolve(); };
        audio.onerror = () => { audioRef.current = null; resolve(); }; // resolve so caller falls back
        audio.play().catch(() => { audioRef.current = null; resolve(); });
      });

    // Speak a sentence via Web Speech (fallback).
    const speakFallback = (text: string, lang: string): Promise<void> =>
      new Promise((resolve) => {
        if (!synth) {
          timerRef.current = setTimeout(resolve, text.split(/\s+/).length * 400);
          return;
        }
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang;
        u.onend = () => resolve();
        u.onerror = () => { timerRef.current = setTimeout(resolve, 2500); };
        synth.speak(u);
      });

    const speakStep = async (idx: number) => {
      if (t !== tokenRef.current) return;
      const step = flow[idx];
      if (!step) { setIsPlaying(false); return; }

      const lang = walkthrough.meta?.language ?? 'en';
      const [ownerStr, repoStr] = (walkthrough.pr.repo ?? '/').split('/');
      const prNumber = walkthrough.pr.number;
      const sentences = splitSentences(step.narration ?? '');

      for (let i = 0; i < sentences.length; i++) {
        if (t !== tokenRef.current) return;
        setNarrationCue({ stepId: step.id, sentence: i });
        const url = audioUrl(ownerStr, repoStr, prNumber, step.id, i);
        // Try the recorded audio first; if there is none (no key, missing static file) fall back to Web Speech.
        let usedApi = false;
        try {
          const probe = await fetch(url, { method: 'HEAD' });
          if (probe.ok) {
            await playSentenceAudio(url);
            usedApi = true;
          }
        } catch {
          // network error — fall through to Web Speech
        }
        if (!usedApi) {
          await speakFallback(sentences[i], lang);
        }
      }

      if (t !== tokenRef.current) return;
      setNarrationCue(null);
      if (all && idx < END - 1) {
        const next = idx + 1;
        screenIndexRef.current = next;
        setScreenIndex(next);
        timerRef.current = setTimeout(() => { void speakStep(next); }, 500);
      } else {
        setIsPlaying(false);
      }
    };

    void speakStep(startIdx);
  }, [flow, END, synth, audioRef, setIsPlaying, setNarrationCue, setScreenIndex, tokenRef, timerRef, walkthrough.meta, walkthrough.pr]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as Element;
      if (target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowRight') go(screenIndexRef.current + 1);
      else if (e.key === 'ArrowLeft') go(screenIndexRef.current - 1);
      else if (e.key === ' ') {
        e.preventDefault();
        if (isPlaying) { stopListen(); } else { listen(); }
      } else if (e.key === 'Escape') {
        setDrawerStepId(null);
        setMapOpen(false);
        setMapFocusNode(undefined);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [go, isPlaying, listen, stopListen, setDrawerStepId, setMapOpen, setMapFocusNode]);

  // Scroll stage to top on screen change
  const stageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (stageRef.current) stageRef.current.scrollTop = 0;
  }, [screenIndex]);

  // Handle next/back
  const handleNext = () => {
    if (screenIndex >= END) go(-1); // summary → start
    else go(screenIndex + 1);
  };
  const handleBack = () => go(screenIndex - 1);
  const handleListen = () => {
    if (isPlaying) { stopListen(); }
    else { listen(screenIndex < 0 || screenIndex >= END); }
  };

  // Drawer step
  const drawerStep = drawerStepId
    ? walkthrough.steps.find((s) => s.id === drawerStepId)
    : null;
  const drawerQuestion = drawerStep
    ? walkthrough.openQuestions.find((q) => q.stepId === drawerStep.id)
    : undefined;

  // Current step screen data
  const currentStep = screenIndex >= 0 && screenIndex < END ? flow[screenIndex] : null;

  const openMap = () => {
    setMapFocusNode(currentStep?.focusNode);
    setMapOpen(true);
  };
  const closeMap = () => {
    setMapOpen(false);
    setMapFocusNode(undefined);
  };

  return (
    <ReviewProvider repo={walkthrough.pr.repo} number={walkthrough.pr.number}>
    <div className="v2app">
      <TopBarV2
        walkthrough={walkthrough}
        plain={plain}
        flow={flow}
        screenIndex={screenIndex}
        onGo={(i) => go(i)}
        onOpenMap={openMap}
      />

      <main className="v2stage" ref={stageRef}>
        {screenIndex < 0 && (
          <StartScreen
            walkthrough={walkthrough}
            plain={plain}
            flow={flow}
          />
        )}

        {currentStep && (() => {
          const p = plain.steps[currentStep.id];
          const parts = walkthrough.parts ?? [];
          const part = parts.find((x) => x.stepIds.includes(currentStep.id));
          const partSteps = part
            ? part.stepIds.map((id) => flow.find((s) => s.id === id)).filter((s): s is Step => !!s)
            : null;
          const chSteps = partSteps ?? flow.filter((s) => plain.steps[s.id]?.ch === p?.ch);
          const stepInChapter = chSteps.indexOf(currentStep) + 1;
          const chapterLabel = part
            ? `Part ${(parts.indexOf(part) + 1)} · ${part.title}`
            : undefined;
          return (
            <StepScreen
              key={currentStep.id}
              step={currentStep}
              stepIndex={screenIndex + 1}
              stepInChapter={stepInChapter}
              chapterTotal={chSteps.length}
              chapterLabel={chapterLabel}
              walkthrough={walkthrough}
              plain={plain}
              checked={!!checks[currentStep.id]}
              onCheck={(v) => setChecks((prev) => ({ ...prev, [currentStep.id]: v }))}
              asked={!!asks[currentStep.id]}
              onAsk={() => setAsks((prev) => ({ ...prev, [currentStep.id]: !prev[currentStep.id] }))}
              verifiedItems={verifiedItems}
              onVerify={(k, v) => setVerifiedItems((prev) => ({ ...prev, [k]: v }))}
              onOpenDrawer={() => setDrawerStepId(currentStep.id)}
              narrationSentence={
                narrationCue?.stepId === currentStep.id ? narrationCue.sentence : null
              }
            />
          );
        })()}

        {screenIndex >= END && (
          <SummaryScreen
            walkthrough={walkthrough}
            plain={plain}
            flow={flow}
            minors={minors}
            checks={checks}
            asks={asks}
            verifiedItems={verifiedItems}
            onGoToStep={(i) => go(i)}
            onOpenDrawer={(id) => setDrawerStepId(id)}
            onOpenMap={openMap}
            onBackToStart={() => go(-1)}
          />
        )}
      </main>

      <BottomBarV2
        screenIndex={screenIndex}
        total={END}
        isPlaying={isPlaying}
        onBack={handleBack}
        onNext={handleNext}
        onListen={handleListen}
      />

      {/* Layer: drawer + scrim */}
      {drawerStepId && drawerStep && (
        <div id="layer">
          <Drawer
            step={drawerStep}
            walkthrough={walkthrough}
            question={drawerQuestion}
            onClose={() => setDrawerStepId(null)}
          />
        </div>
      )}

      {mapOpen && (
        <MapModal
          walkthrough={walkthrough}
          edgesPlain={plain.edges}
          focusNode={mapFocusNode}
          onClose={closeMap}
        />
      )}
    </div>
    </ReviewProvider>
  );
}
