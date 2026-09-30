/**
 * quality.ts — soft checks against docs/output-contract.md. These are
 * WARNINGS, never hard failures: schema validity and verbatim-code checks
 * (schema.ts / verbatim.ts, orchestrated by index.ts) are what actually
 * blocks saving a walkthrough. This module answers "is it good", not
 * "is it valid".
 */

import type { Step, Walkthrough } from "@pr-walkthrough/shared";

export interface QualityWarning {
  code: string;
  message: string;
  stepId?: string;
}

/**
 * Codes worth one automatic `--resume` repair (Q2): output-contract breaks a
 * reviewer or the TTS voice notices directly. Field-length limits are in here
 * because the only fix is rewriting the prose — there is no deterministic
 * shortener, and left as warnings they used to be trimmed by hand. Structural
 * soft warnings (step count, map share, …) stay warnings only — repairing
 * those would churn the whole draft.
 */
export const CRITICAL_QUALITY_CODES = new Set([
  "identifier-in-say",
  "identifier-in-headline",
  "identifier-in-narration",
  "identifier-in-plain",
  "narration-mentions-process",
  "headline-too-long",
  "say-too-long",
  "narration-too-long",
  // The model's own second thoughts ("… 90 — wait, actually above both …") read aloud by the voice.
  "thinking-aloud",
  "refers-to-screenshot",
  // Diagram rules (see analyzer-prompt.md → Visuals): a diagram that breaks them is worse than none.
  "visual-label-identifier",
  "flow-too-many-marks",
  "flow-too-big",
  "layers-no-changed-item",
  "layers-unchanged-item",
  "layers-too-many",
  "layers-not-sorted",
  "symptom-step-visual",
]);

export function criticalQualityWarnings(warnings: QualityWarning[]): QualityWarning[] {
  return warnings.filter((w) => CRITICAL_QUALITY_CODES.has(w.code));
}

// ---------------------------------------------------------------------------
// "Does this look like an identifier / file name?" heuristics
// ---------------------------------------------------------------------------

const BACKTICK = /`[^`]+`/;
const CAMEL_OR_PASCAL = /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*\b/;
const CODE_FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|scss|css|json|py|go|rs|java|rb|kt|swift|yml|yaml|md)\b/i;
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/;
/** Narration must state a conclusion, never how it was checked (ST12's evidence loop). */
/**
 * The model correcting itself mid-sentence. Seen on a live #10295 run: "below the context menu at 90 —
 * wait, actually above both context menu and top bar". Plain prose never needs these; the voice reads
 * them out verbatim.
 */
const THINKING_ALOUD =
  /(?:[—–,;:.(]\s*|^)(?:wait|hmm+|oops|er|um)\b|\bwait,? actually\b|\bactually,? (?:no|wait)\b|\b(?:I mean|let me (?:check|re-?check|see|think|correct)|scratch that|on second thought|correction:)/i;

/** Narration is listened to: past this many words a step drags (the reference steps run 40–65). */
const NARRATION_MAX_WORDS = 75;

const PROCESS_WORDS = /\b(ablation|the measurement|measurement confirms|the backend (verified|confirmed)|verification confirms)\b/i;
const PATH_SEGMENT = /\b[\w.-]+\/[\w.-]+\b/;
/**
 * Prose must read true with or without screenshots — the backend adds them only
 * for some PRs, and only sometimes succeeds. Narrow on purpose ("image" alone is
 * a code word); only phrases that point at a picture the reader is looking at.
 */
const SCREENSHOT_REF =
  /\b(screen[- ]?shots?|as (?:you can |we can )?see (?:in|on|below|above|here)|(?:shown|pictured|visible) (?:above|below|here|in the (?:image|picture|shot|screenshot))|(?:in|on) the (?:picture|screenshot|screen shot|shot)|(?:see|look at) the (?:picture|screenshot|shot|image))\b/i;

/** Best-effort, deliberately over-eager — false positives are cheap for a warning a human reads. */
function looksLikeIdentifier(text: string): boolean {
  return (
    BACKTICK.test(text) ||
    CAMEL_OR_PASCAL.test(text) ||
    CODE_FILE_EXT.test(text) ||
    SNAKE_CASE.test(text) ||
    PATH_SEGMENT.test(text)
  );
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Step-count budget by PR size (docs/output-contract.md)
// ---------------------------------------------------------------------------

/**
 * Based on `coverage.explained` (hunks that actually earned a step), not the
 * raw hunk count — `skippedHunks` already removes mechanical noise, and this
 * avoids re-guessing which reasons count as "mechanical" from free text.
 * Each bucket's upper end has headroom for narrative steps that carry no
 * hunk at all (symptom, cause, decision, verification, a dead end) — a
 * reasoning chain naturally has a few of these beyond the hunks themselves.
 */
function stepBudget(explainedHunks: number): [min: number, max: number] {
  if (explainedHunks <= 5) return [3, 8];
  if (explainedHunks <= 50) return [5, 15];
  return [8, 18];
}

const TEST_FILE = /\.(test|spec)\.|__tests__|__snapshots__|\.snap$/i;

// ---------------------------------------------------------------------------
// Diagram (visual) checks
// ---------------------------------------------------------------------------

/** kebab-case with 3+ parts (`data-prevent-outside-click`): code, not words, in a diagram label. */
const KEBAB_CASE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+){2,}\b/;
const CSS_VAR = /(?:^|\s|\()--[a-z]/i;
/** `data-prevent…`, `aria-…`: an HTML attribute name, even when the label cuts it short. */
const HTML_ATTRIBUTE = /\b(?:data|aria)-[a-z]/i;

/** Diagram labels are read by people at a glance: plain words only. */
function looksLikeCodeLabel(text: string): boolean {
  return looksLikeIdentifier(text) || KEBAB_CASE.test(text) || CSS_VAR.test(text) || HTML_ATTRIBUTE.test(text);
}

const MAX_FLOW_NODES = 6;
const MAX_FLOW_ROW = 4;
const MAX_LABEL_WORDS = 6;
const MAX_LAYERS_PER_SIDE = 4;

type LayerItem = [string, number] | [string, number, string];

/**
 * A layers diagram exists to show ONE thing: where the changed item now sits relative to the others.
 * Only items whose order relative to it CHANGED explain that. An item that stays on the same side
 * adds nothing — except one on the side the value moves toward (the ceiling a raised value must
 * stay under, the floor a lowered one must stay over), which shows how far is too far.
 * Returns the labels that are just noise: unchanged items behind the move, and any beyond the first
 * "limit" item. Empty when the changed item can't be identified (nothing to judge).
 */
export function unchangedLayerItems(before: LayerItem[], after: LayerItem[]): string[] {
  const changed = after.find((i) => i[2] === "hl");
  if (!changed) return [];
  const was = before.find((i) => i[0] === changed[0]);
  if (!was || was[1] === changed[1]) return [];
  const [b, a] = [was[1], changed[1]];
  const dir = a > b ? 1 : -1;
  const noise: string[] = [];
  let limits = 0;
  for (const [label, valueBefore] of before) {
    if (label === changed[0]) continue;
    const inAfter = after.find((i) => i[0] === label);
    if (!inAfter) continue;
    const valueAfter = inAfter[1];
    const sideBefore = Math.sign(valueBefore - b);
    const sideAfter = Math.sign(valueAfter - a);
    if (sideBefore !== sideAfter) continue; // order changed: this is what the diagram is for
    const beyond = dir > 0 ? valueAfter > a : valueAfter < a;
    if (beyond && ++limits === 1) continue; // one limit item is useful
    noise.push(label);
  }
  return noise;
}

function checkVisual(step: Step, warn: (code: string, message: string, stepId?: string) => void): void {
  const v = step.visual;
  if (!v) return;

  if (v.type === "flow") {
    const nodes = v.rows.flat();
    for (const [label] of nodes) {
      if (looksLikeCodeLabel(label)) {
        warn("visual-label-identifier", `Step ${step.id}'s diagram label looks like code, not plain words: "${label}"`, step.id);
      }
      const words = wordCount(label);
      if (words > MAX_LABEL_WORDS) {
        warn("flow-too-big", `Step ${step.id}'s diagram label is ${words} words (limit ${MAX_LABEL_WORDS}): "${label}"`, step.id);
      }
    }
    if (nodes.length > MAX_FLOW_NODES || v.rows.some((r) => r.length > MAX_FLOW_ROW)) {
      warn("flow-too-big", `Step ${step.id}'s diagram has ${nodes.length} nodes in ${v.rows.length} row(s) (limit ${MAX_FLOW_NODES} in total, ${MAX_FLOW_ROW} per row) — keep only the chain the reader needs.`, step.id);
    }
    // A mark says "this is where the chain ends up" — so only a row's LAST node carries one, and
    // only one. Marking every step of a chain red or green (the habit a sloppy few-shot example
    // teaches) makes the colour meaningless.
    for (const row of v.rows) {
      const marked = row.map(([, cls], i) => ({ cls, i })).filter((n) => n.cls === "bad" || n.cls === "good");
      if (marked.length > 1 || (marked.length === 1 && marked[0].i !== row.length - 1)) {
        warn("flow-too-many-marks", `Step ${step.id}'s diagram marks ${marked.length} node(s) "bad"/"good" in one row — only the final node of a row may carry a mark (the outcome), and only one.`, step.id);
        break;
      }
    }
  }

  if (v.type === "layers") {
    for (const [label] of [...v.before, ...v.after]) {
      if (looksLikeCodeLabel(label)) {
        warn("visual-label-identifier", `Step ${step.id}'s diagram label looks like code, not plain words: "${label}"`, step.id);
      }
    }
    if (!v.after.some((i) => i[2] === "hl")) {
      warn("layers-no-changed-item", `Step ${step.id}'s layers diagram doesn't mark the changed item ("hl") in the After column.`, step.id);
    }
    if (v.before.length > MAX_LAYERS_PER_SIDE || v.after.length > MAX_LAYERS_PER_SIDE) {
      warn("layers-too-many", `Step ${step.id}'s layers diagram has ${Math.max(v.before.length, v.after.length)} rows (limit ${MAX_LAYERS_PER_SIDE}) — show only items whose order relative to the changed one changes.`, step.id);
    }
    // The viewer draws the list top to bottom as "top = drawn last / wins". A column written
    // lowest-first shows the wrong picture: the item that loses appears to win.
    for (const [title, column] of [["Before", v.before], ["After", v.after]] as const) {
      const values = column.map((i) => i[1]);
      if (values.some((val, i) => i > 0 && val > values[i - 1])) {
        warn("layers-not-sorted", `Step ${step.id}'s layers diagram lists the ${title} column lowest-first — the top row must be the highest value (drawn last / wins), or the picture shows the wrong winner.`, step.id);
        break;
      }
    }
    const noise = unchangedLayerItems(v.before as LayerItem[], v.after as LayerItem[]);
    if (noise.length > 0) {
      warn("layers-unchanged-item", `Step ${step.id}'s layers diagram shows item(s) whose order relative to the changed one doesn't change: ${noise.join(", ")} — they explain nothing; drop them.`, step.id);
    }
  }
}

// ---------------------------------------------------------------------------
// checkQuality
// ---------------------------------------------------------------------------

export function checkQuality(walkthrough: Walkthrough): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  const warn = (code: string, message: string, stepId?: string): void => {
    warnings.push(stepId ? { code, message, stepId } : { code, message });
  };

  // --- plain-language layer: no identifiers ---
  if (walkthrough.plain) {
    const fields: [string, string][] = [
      ["plain.title", walkthrough.plain.title],
      ["plain.problem", walkthrough.plain.problem],
      ["plain.fix", walkthrough.plain.fix],
    ];
    for (const [field, text] of fields) {
      if (looksLikeIdentifier(text)) {
        warn("identifier-in-plain", `${field} looks like it contains an identifier or file name: "${text}"`);
      }
      if (SCREENSHOT_REF.test(text)) {
        warn("refers-to-screenshot", `${field} refers to a screenshot ("${text}") — screenshots are optional, the text must stand without them.`);
      }
      if (THINKING_ALOUD.test(text)) {
        warn("thinking-aloud", `${field} contains the writer correcting itself — state only the final, correct fact: "${text}"`);
      }
    }
  }

  // --- per-step checks ---
  for (const step of walkthrough.steps) {
    if (step.headline) {
      if (looksLikeIdentifier(step.headline)) {
        warn("identifier-in-headline", `Step ${step.id}'s headline looks like it contains an identifier or file name: "${step.headline}"`, step.id);
      }
      const words = wordCount(step.headline);
      if (words > 9) {
        warn("headline-too-long", `Step ${step.id}'s headline is ${words} words (limit 9): "${step.headline}"`, step.id);
      }
    }

    if (step.say) {
      if (looksLikeIdentifier(step.say)) {
        warn("identifier-in-say", `Step ${step.id}'s "say" looks like it contains an identifier or file name: "${step.say}"`, step.id);
      }
      const sentences = sentenceCount(step.say);
      if (sentences > 2) {
        warn("say-too-long", `Step ${step.id}'s "say" has ${sentences} sentences (should be one or two): "${step.say}"`, step.id);
      }
    }

    // Narration is read aloud by TTS: code names come out garbled, so the same
    // no-identifiers rule as `say` applies — and 2–4 sentences.
    if (step.narration) {
      if (looksLikeIdentifier(step.narration)) {
        warn("identifier-in-narration", `Step ${step.id}'s narration looks like it contains an identifier or file name — TTS will read it aloud: "${step.narration}"`, step.id);
      }
      const sentences = sentenceCount(step.narration);
      const nWords = wordCount(step.narration);
      if (sentences > 4) {
        warn("narration-too-long", `Step ${step.id}'s narration has ${sentences} sentences (limit 4).`, step.id);
      } else if (nWords > NARRATION_MAX_WORDS) {
        // Four long sentences are still a minute of audio: the word limit catches what the count can't.
        warn("narration-too-long", `Step ${step.id}'s narration is ${nWords} words (limit ${NARRATION_MAX_WORDS}) — keep the point, drop the least essential detail.`, step.id);
      }
      // ST12 evidence loop (bob-revise.ts): narration must read like every other
      // step's — the listener isn't told how a claim was checked.
      if (PROCESS_WORDS.test(step.narration)) {
        warn("narration-mentions-process", `Step ${step.id}'s narration mentions how a claim was checked (e.g. "ablation", "confirms") instead of just stating it: "${step.narration}"`, step.id);
      }
    }

    const spoken: [string, string | undefined][] = [
      ["headline", step.headline],
      ["say", step.say],
      ["narration", step.narration],
    ];
    if (step.visual?.type === "symptoms") {
      step.visual.items.forEach((item, i) =>
        spoken.push([`symptom ${i + 1}`, typeof item === "string" ? item : item.text])
      );
    }
    for (const [field, text] of spoken) {
      if (text && THINKING_ALOUD.test(text)) {
        warn("thinking-aloud", `Step ${step.id}'s ${field} contains the writer correcting itself ("${text.match(THINKING_ALOUD)?.[0].trim()}") — state only the final, correct fact: "${text}"`, step.id);
      }
      if (text && SCREENSHOT_REF.test(text)) {
        warn("refers-to-screenshot", `Step ${step.id}'s ${field} refers to a screenshot ("${text}") — screenshots are optional, the text must stand without them.`, step.id);
      }
    }

    checkVisual(step, warn);

    // The symptom step is where the reader learns WHAT goes wrong, and its `symptoms` list is what the
    // screenshot verifier builds a scenario (and a card with a picture) for. A diagram there instead
    // leaves the verifier nothing to show and the reader no list of problems.
    if (step.kind === "symptom" && !step.minor && step.visual?.type !== "symptoms") {
      warn("symptom-step-visual", `Step ${step.id} is the symptom step but its visual is ${step.visual ? `"${step.visual.type}"` : "missing"} — use a \`symptoms\` list (one item per thing the user sees go wrong).`, step.id);
    }

    // One step = one decision: a change that removes a guard AND adds its replacement AND touches many
    // files is two steps. Soft — splitting is a restructure, not a wording repair; up to three files
    // is a cohesive implementation (it usually follows its own decision step), so only more warns.
    if (step.kind === "change" && !step.minor) {
      const files = new Set(step.hunkIds.map((id) => id.replace(/#\d+$/, "")));
      if (files.size > 3) {
        warn("step-many-hunks", `Step ${step.id} spans ${files.size} files (${step.hunkIds.length} hunks) — a change step that does more than one thing should be split (one decision per step).`, step.id);
      }
    }

    if (!step.minor && !step.visual && step.beats.some((b) => (b.traces ?? []).length > 0)) {
      warn("traces-without-visual", `Step ${step.id} has event traces but no \`visual\` — the reviewer sees the raw trace instead of a plain-words flow.`, step.id);
    }

    const hasCode = step.beats.some((b) => (b.code ?? []).length > 0);
    if (!step.minor && !hasCode && step.kind !== "symptom" && step.kind !== "verification") {
      warn("step-without-code", `Step ${step.id} (${step.kind}) quotes no code — the reviewer can't tell what it refers to.`, step.id);
    }

    for (const beat of step.beats) {
      for (const block of beat.code ?? []) {
        if (TEST_FILE.test(block.file)) {
          warn("test-file-quoted", `Step ${step.id} quotes a test/snapshot file (${block.file}) — tests should never get their own explanation.`, step.id);
        }
      }
    }
  }

  // --- visual.map should be the exception, not the rule ---
  const totalSteps = walkthrough.steps.length;
  const mapSteps = walkthrough.steps.filter((s) => s.visual?.type === "map").length;
  if (totalSteps > 0 && mapSteps / totalSteps > 0.3) {
    warn("too-many-maps", `${mapSteps} of ${totalSteps} steps use the dependency map — reserve it for structural steps (see docs/output-contract.md).`);
  }

  // --- step count vs. PR size ---
  if (walkthrough.coverage) {
    const explained = walkthrough.coverage.explained;
    const [min, max] = stepBudget(explained);
    const nonMinorSteps = walkthrough.steps.filter((s) => !s.minor).length;
    if (nonMinorSteps < min || nonMinorSteps > max) {
      warn(
        "step-count-out-of-budget",
        `${nonMinorSteps} non-minor step(s) for ${explained} explained hunk(s) — expected ${min}-${max} (see docs/output-contract.md).`
      );
    }
  }

  // --- backend bookkeeping sanity ---
  if (walkthrough.meta.analyzer === "bob-shell" && !walkthrough.meta.run) {
    warn("missing-run-meta", "meta.analyzer is \"bob-shell\" but meta.run is missing — the backend should always attach run stats for a real Bob Shell call.");
  }

  return warnings;
}
