# Rubric template — the quality bar for any PR

`docs/rubrics/<pr>.md` files apply this template to one demo PR. Nothing here may
name a specific repository, file or value: if a check only makes sense for one PR,
it belongs in that PR's rubric, not in the analyzer prompt or `quality.ts`.

Score by hand after a live run. Pass = every "must" holds; "should" items are
tracked but not blocking.

## Content (must)

1. **The fix is explained as a mechanism, not a diff.** Each step answers one
   question — what breaks, why, what was decided, what changed — and states the
   concrete values or conditions involved, not adjectives.
2. **Constants and one-line edits that ARE the fix get a step**, with the real
   before/after values and every neighbour the value is compared with (the item it
   must beat, and the ceiling it must stay under, when the code has one).
3. **A removed guard, flag or attribute is traced to what now behaves differently
   because it is gone** (who listens, who used to be blocked). Never called
   "cleanup" or "redundant" without that trace.
4. **Two mechanisms stay two.** If a supporting change exists only to keep the main
   fix from breaking something else, it is a separate, labelled step — not merged
   into the main mechanism.
5. **Type-only or compile-only edits** are in `skippedHunks` (or folded into the step
   they support, `minor`), never a full step.
6. **Coverage is complete**: every hunk is in a step or in `skippedHunks` with a reason.
7. **Open questions are real** — silent failure paths or behaviour changes nobody
   mentioned — each pointing at the step and code that prompted it, tagged `inferred`.

## Presentation (must)

8. `headline` ≤ 9 words, `say` ≤ 2 sentences, `narration` ≤ 4 sentences, none with
   identifiers; narration never mentions how a claim was checked.
9a. **The symptom step lists every visible problem** (one `symptoms` item each, a phone-only problem
    as its own item), and `plain.problem` names them all — a PR with two visible effects must not read as
    having one.
9. Problem chapter carries evidence that works **without screenshots** (symptoms,
   a diagram, BASE code). Symptoms read as what a user sees; a single short
   parenthesis is allowed only when the cause is one obvious comparison.
10. **No prose refers to a picture.** Read the text with every image removed — it must
    still be complete and true.
11. A diagram adds something `say` + `narration` + the code don't already give in a glance —
    otherwise there is none. Labels are plain words, no identifiers or variable names. `flow`:
    only a row's last node is marked (the outcome), `old` only for a removed guard/path,
    before/after use `rowTitles`, ≤6 nodes. `layers`: only the changed item and the items whose
    order relative to it changes (plus at most one limit on the side it moves toward), ≤4 rows.
12. **The decision names the alternative that was not taken**, when there is an obvious one
    ("instead of calling X from every caller"). A reviewer judges a choice by what it beat.
13. **No change step mixes removing a guard with adding its replacement** across several files —
    that is a cause/decision step followed by an implementation step.

## Screenshots (state-dependent — check the state that actually happened)

14. Captured → pair shown, frames genuinely differ, highlights cover the changed area.
15. Captured but identical → no pair, plain note, walkthrough unaffected.
16. Not attempted / not possible / failed → one honest plain sentence on the start
    screen, no internal error text, walkthrough unaffected.
17. Per-symptom frames only where they add something over the main "before".

## How to run the check without overfitting

Run the rubric on the demo PR **and** on a PR from a different repository or kind
(non-visual, or a repo with no app recipe). A rule that helps only the demo PR is a
hard-coded answer — fix it or drop it.
