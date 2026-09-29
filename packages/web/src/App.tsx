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
import { ReviewProvider, type AskResult } from './review';
import { MapModal } from './MapModal';
import { useWalkthroughNarration, buildOutroNarration } from './useWalkthroughNarration';
import './styles.css';
import './v2.css';

export default function App() {
  const walkthroughState = useWalkthrough();

  // ---- Screen state ----
  // -1 = start screen, 0..flow.length-1 = step screens, flow.length = summary
  const [screenIndex, setScreenIndex] = useState(-1);

  // ---- Check / ask / verify state ----
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [askResults, setAskResults] = useState<Record<string, AskResult>>({});
  const [verifiedItems, setVerifiedItems] = useState<Record<number, boolean>>({});

  // ---- Drawer state ----
  const [drawerStepId, setDrawerStepId] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapFocusNode, setMapFocusNode] = useState<string | undefined>(undefined);

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
      askResults={askResults}
      setAskResults={setAskResults}
      verifiedItems={verifiedItems}
      setVerifiedItems={setVerifiedItems}
      drawerStepId={drawerStepId}
      setDrawerStepId={setDrawerStepId}
      mapOpen={mapOpen}
      setMapOpen={setMapOpen}
      mapFocusNode={mapFocusNode}
      setMapFocusNode={setMapFocusNode}
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
  askResults: Record<string, AskResult>;
  setAskResults: React.Dispatch<React.SetStateAction<Record<string, AskResult>>>;
  verifiedItems: Record<number, boolean>;
  setVerifiedItems: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  drawerStepId: string | null;
  setDrawerStepId: (id: string | null) => void;
  mapOpen: boolean;
  setMapOpen: (v: boolean) => void;
  mapFocusNode: string | undefined;
  setMapFocusNode: (v: string | undefined) => void;
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
  askResults,
  setAskResults,
  verifiedItems,
  setVerifiedItems,
  drawerStepId,
  setDrawerStepId,
  mapOpen,
  setMapOpen,
  mapFocusNode,
  setMapFocusNode,
  END,
}: InnerProps) {
  const walkthrough = walkthroughState.data;
  const [ownerStr = '', repoStr = ''] = (walkthrough.pr.repo ?? '/').split('/');

  const hasGraph = (walkthrough.graph?.nodes?.length ?? 0) > 0;
  const outroNarration = buildOutroNarration({ hasGraph });

  const {
    mode,
    setMode,
    status,
    narrationCue,
    hasOutro,
    toggle,
    onManualNavigate,
  } = useWalkthroughNarration({
    flow,
    endIndex: END,
    screenIndex,
    setScreenIndex,
    language: walkthrough.meta?.language ?? 'en',
    owner: ownerStr,
    repo: repoStr,
    prNumber: walkthrough.pr.number,
    outroNarration,
  });

  const screenIndexRef = useRef(screenIndex);
  screenIndexRef.current = screenIndex;

  const go = useCallback(
    (i: number) => {
      const clamped = Math.max(-1, Math.min(END, i));
      if (clamped === screenIndexRef.current) return;
      onManualNavigate(clamped);
      screenIndexRef.current = clamped;
      setScreenIndex(clamped);
    },
    [END, onManualNavigate, setScreenIndex]
  );

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as Element;
      if (target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowRight') go(screenIndexRef.current + 1);
      else if (e.key === 'ArrowLeft') go(screenIndexRef.current - 1);
      else if (e.key === ' ') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape') {
        setDrawerStepId(null);
        setMapOpen(false);
        setMapFocusNode(undefined);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [go, toggle, setDrawerStepId, setMapOpen, setMapFocusNode]);

  // Scroll stage to top on screen change
  const stageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (stageRef.current) stageRef.current.scrollTop = 0;
  }, [screenIndex]);

  const handleNext = () => {
    if (screenIndex >= END) go(-1); // summary → start
    else go(screenIndex + 1);
  };
  const handleBack = () => go(screenIndex - 1);

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
              askResult={askResults[currentStep.id]}
              onAskDone={(result) =>
                setAskResults((prev) => ({ ...prev, [currentStep.id]: result }))
              }
              verifiedItems={verifiedItems}
              onVerify={(k, v) => setVerifiedItems((prev) => ({ ...prev, [k]: v }))}
              onOpenDrawer={() => setDrawerStepId(currentStep.id)}
              narrationSentence={
                narrationCue?.stepId === currentStep.id
                  ? narrationCue.sentence
                  : null
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
            askResults={askResults}
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
        status={status}
        mode={mode}
        hasOutro={hasOutro}
        onBack={handleBack}
        onNext={handleNext}
        onListen={toggle}
        onModeChange={setMode}
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
