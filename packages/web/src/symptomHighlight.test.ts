import { describe, expect, it } from 'vitest';
import cases from './symptomHighlight.cases.json';
import { splitSentences, symptomForSentence } from './symptomHighlight';

/** The real Problem steps (live + local data, Oct 1): which card each narration sentence lights, 1-based, '-' = none. */
const EXPECTED: Record<string, string> = {
  'excalidraw/excalidraw/10199': '1 2', // two sentences, two symptoms, no intro (lit nothing, then the wrong card before)
  'excalidraw/excalidraw/10295': '- 1 2',
  'excalidraw/excalidraw/12053': '- 1 2',
  'excalidraw/excalidraw/10943': '- 1 2',
  'excalidraw/excalidraw/10682': '1 1',
  'an2323/excalidraw/21': '1 1',
  'excalidraw/excalidraw/8340 (local)': '1 2 3', // was one sentence late
  'outline/outline/13673 (local)': '- 1 2',
};

const lit = (narration: string, items: string[]) =>
  splitSentences(narration)
    .map((_, k) => {
      const i = symptomForSentence(k, narration, items);
      return i == null ? '-' : String(i + 1);
    })
    .join(' ');

describe('symptomForSentence — the card that lights while a sentence plays', () => {
  for (const c of cases as { pr: string; narration: string; items: string[] }[]) {
    it(c.pr, () => expect(lit(c.narration, c.items)).toBe(EXPECTED[c.pr]));
  }

  it('three symptoms with an introduction and a wrap-up: the middle sentences, in order', () => {
    const items = ['The toolbar flickers', 'The sidebar jumps', 'The canvas goes blank'];
    const narration = 'Three things go wrong here. One thing breaks first. Another thing breaks next. A last thing breaks too. That is the whole story.';
    expect(lit(narration, items)).toBe('- 1 2 3 -');
  });

  it('a sentence clearly about one symptom wins over its position', () => {
    const items = ['The sidebar covers the context menu', 'On a phone the layer-ordering items show up'];
    const narration = 'On touch devices the menu shows layer-ordering items. Separately, the sidebar covers the context menu.';
    expect(lit(narration, items)).toBe('2 1');
  });

  it('prose that matches neither the words nor the shape lights nothing', () => {
    const items = ['A', 'B'];
    const narration = 'One. Two. Three. Four. Five.';
    expect(lit(narration, items)).toBe('- - - - -');
  });

  it('no sentence playing, no symptoms, or an index out of range: nothing', () => {
    expect(symptomForSentence(null, 'One. Two.', ['a', 'b'])).toBeNull();
    expect(symptomForSentence(0, 'One. Two.', [])).toBeNull();
    expect(symptomForSentence(5, 'One. Two.', ['a', 'b'])).toBeNull();
  });
});
