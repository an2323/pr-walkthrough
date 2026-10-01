/**
 * symptomHighlight.ts — which symptom card lights up while a narration sentence plays.
 *
 * The narration is written as prose, not as one sentence per symptom, so the index alone is a guess. Two rules,
 * in order:
 *  1. a sentence that is clearly about one symptom (shares at least two words with it, and two more than with any
 *     other) lights that one;
 *  2. otherwise the shape of the text decides: as many sentences as symptoms → in order; one or two more →
 *     the first is an introduction (and the last a wrap-up), the rest in order. Anything else lights nothing.
 * Pure, so it is tested on the real narrations (symptomHighlight.test.ts).
 */

/** The player's sentence split (useWalkthroughNarration.ts) — the cue index counts these. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const STOP = new Set(
  'the and but are was were been its this that these those for with from when while does not also same than then there their they you your can could would will just only into onto over under after before menu open opens opened'.split(' ')
);
/** Words that name the same thing in symptoms and narration ("phone-sized screen" / "touch devices"). */
const SAME: Record<string, string> = { phone: 'mobile', tablet: 'mobile', touch: 'mobile', mobile: 'mobile' };

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (let w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(SAME[w] ?? w);
  }
  return out;
}

export function symptomForSentence(sentence: number | null | undefined, narration: string, symptoms: string[]): number | null {
  const m = symptoms.length;
  if (sentence == null || m === 0) return null;
  const sentences = splitSentences(narration);
  const n = sentences.length;
  if (sentence < 0 || sentence >= n) return null;

  // 1. clearly about one symptom
  const said = words(sentences[sentence]);
  const scores = symptoms.map((s) => [...words(s)].filter((w) => said.has(w)).length);
  const best = Math.max(...scores);
  const second = [...scores].sort((a, b) => b - a)[1] ?? 0;
  if (best >= 2 && best - second >= 2) return scores.indexOf(best);

  // 2. the shape of the text
  if (n === m) return sentence;
  if (n === m + 1 || n === m + 2) {
    const i = sentence - 1;
    return i >= 0 && i < m ? i : null;
  }
  return null;
}
