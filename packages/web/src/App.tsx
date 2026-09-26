import { useState, useCallback, useRef } from 'react';
import type { GraphNode } from '@pr-walkthrough/shared';
import { useWalkthrough } from './useWalkthrough';
import { TopBar } from './TopBar';
import { RouteRail } from './RouteRail';
import { GraphView } from './GraphView';
import { StepView } from './StepView';
import { StepNav } from './StepNav';
import { QuestionsPanel } from './QuestionsPanel';
import { CoveragePanel } from './CoveragePanel';
import './styles.css';
import './App.css';
import './PanelStyles.css';

const hasApi = typeof window !== 'undefined' && 'speechSynthesis' in window;

export default function App() {
  const state = useWalkthrough();
  const [activeIndex, setActiveIndex] = useState(0);
  const [playAll, setPlayAll] = useState(false);

  // Keep stable refs to avoid stale closures in speech callbacks
  const playAllRef = useRef(playAll);
  playAllRef.current = playAll;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  const stepsRef = useRef(state.status === 'ok' ? state.data.steps : []);
  if (state.status === 'ok') stepsRef.current = state.data.steps;

  const langRef = useRef('en');
  if (state.status === 'ok') langRef.current = state.data.meta?.language ?? 'en';

  // Core speak function — always uses current refs
  const speakNarration = useCallback((text: string, chain: boolean) => {
    if (!hasApi) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.startsWith(langRef.current));
    if (voice) u.voice = voice;
    u.rate = 1.02;
    u.onend = () => {
      if (!chain && !playAllRef.current) return;
      const steps = stepsRef.current;
      const next = activeIndexRef.current + 1;
      if (next < steps.length) {
        setTimeout(() => {
          activeIndexRef.current = next;
          setActiveIndex(next);
          speakNarration(steps[next].narration, true);
        }, 700);
      }
    };
    window.speechSynthesis.speak(u);
  }, []);

  const cancelSpeech = useCallback(() => {
    if (hasApi) window.speechSynthesis.cancel();
  }, []);

  // Navigate to a step, optionally chaining speech
  const navigate = useCallback(
    (index: number, chain = false) => {
      const steps = stepsRef.current;
      if (index < 0 || index >= steps.length) return;
      cancelSpeech();
      activeIndexRef.current = index;
      setActiveIndex(index);
      if (chain || playAllRef.current) {
        setTimeout(() => speakNarration(steps[index].narration, true), 50);
      }
    },
    [cancelSpeech, speakNarration]
  );

  const handlePlayAllChange = useCallback(
    (checked: boolean) => {
      playAllRef.current = checked;
      setPlayAll(checked);
      if (!checked) {
        cancelSpeech();
      } else {
        const steps = stepsRef.current;
        if (steps.length > 0) {
          setTimeout(() => speakNarration(steps[activeIndexRef.current].narration, true), 50);
        }
      }
    },
    [cancelSpeech, speakNarration]
  );

  if (state.status === 'idle') {
    return (
      <div style={{ padding: 40 }}>
        <p>
          Add <code>?local=/outline-13673.walkthrough.json</code> to the URL to load a walkthrough.
        </p>
        <p>
          Example:{' '}
          <a href="/?local=/outline-13673.walkthrough.json">
            /?local=/outline-13673.walkthrough.json
          </a>
        </p>
      </div>
    );
  }

  if (state.status === 'loading') {
    return <div style={{ padding: 40 }}>Loading…</div>;
  }

  if (state.status === 'error') {
    return (
      <div style={{ padding: 40, color: 'var(--danger)' }}>Error: {state.message}</div>
    );
  }

  const { data } = state;
  const { steps, graph, openQuestions, hunks, skippedHunks } = data;
  const nodeById = Object.fromEntries(
    graph.nodes.map((n) => [n.id, n])
  ) as Record<string, GraphNode>;
  const step = steps[activeIndex];

  return (
    <>
      <TopBar data={data} />
      <div className="wrap">
        <RouteRail
          steps={steps}
          nodeById={nodeById}
          activeIndex={activeIndex}
          onSelect={(j) => navigate(j)}
        />
        <main>
          <GraphView graph={graph} steps={steps} activeIndex={activeIndex} />
          <StepView
            step={step}
            stepNumber={activeIndex + 1}
            openQuestions={openQuestions}
            onSpeak={() => speakNarration(step.narration, false)}
          />
          <StepNav
            activeIndex={activeIndex}
            total={steps.length}
            playAll={playAll}
            onPrev={() => navigate(activeIndex - 1)}
            onNext={() => navigate(activeIndex + 1)}
            onPlayAllChange={handlePlayAllChange}
          />
          <div className="lower">
            <QuestionsPanel questions={openQuestions} steps={steps} />
            <CoveragePanel hunks={hunks} skippedHunks={skippedHunks} steps={steps} />
          </div>
        </main>
      </div>
    </>
  );
}
