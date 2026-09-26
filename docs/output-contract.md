# Output contract

The single source of truth for what makes a walkthrough good. `docs/analyzer-prompt.md`
implements these rules for the analyzer; `packages/server/src/validation/quality.ts`
checks a finished walkthrough against them (as warnings, not hard failures — schema
validity and verbatim-code checks in `validation/index.ts` are the only things that
block saving). `docs/rubrics/*.md` apply this contract to specific demo PRs by hand.

This document also records product decisions from user discussion that shape the
contract but don't belong in the runtime prompt itself.

## Core logic vs. everything else

A step must earn its place: it shows a decision, a cause, or a mechanism the reviewer
needs in order to judge the PR. Everything else — imports/exports, renames, type
tweaks that only make new code compile, formatting, lockfiles, generated files, and
**all** test/snapshot hunks — goes to `skippedHunks` with a short reason, never a step.
Judge by role, not by kind: a one-line config or import change that *is* the fix
(a z-index, a feature flag) is core logic and earns a step.

Every hunk must land in exactly one place: a step's `hunkIds`, or `skippedHunks`.
`coverage.uncoveredHunkIds` must be empty. Skipping is not a failure — the summary
screen shows what was skipped and why, so nothing is silently hidden.

`packages/server/src/analyzer/classify-hunks.ts` pre-filters the mechanical
categories (tests, snapshots, lockfiles, translations, generated files) before the
prompt is even built, so the analyzer never has to identify those itself and never
spends tokens listing them.

## Step budget by PR size

Sized by `coverage.explained` (hunks that actually earned a step) — this is what
`quality.ts` checks against. Each range's top end leaves headroom for narrative steps
that carry no hunk at all (`symptom`, `cause`/`constraint`, `decision`,
`verification`, a `dead_end`) — a reasoning chain naturally has a few of these beyond
the hunks themselves; Outline #13673's 11 steps for 9 explained hunks is a real
example that should NOT be flagged, and was the case that calibrated these ranges.

| Explained hunks | Steps |
|---|---|
| ≤ 5 | 3–8 |
| ≤ 50 | 5–15 |
| > 50 | 8–18, focused on the mechanism — a big PR does not mean a long walkthrough |

## Plain-language layer

`plain.title/problem/fix` (whole PR) and `step.headline/say` (per step) are read by
a reviewer under time pressure, so:

- **No identifiers, no file names, no code syntax.** `headline` ≤ 9 words; `say` is
  one or two short sentences. Both describe intent ("close the sidebar when the menu
  opens"), never restate the diff.
- `step.check` — no longer produced (Sep 26): the viewer hides "Your check" cards
  (`SHOW_CHECKS = false`); a reviewer reading a PR shouldn't be sent to click around
  the app.
- `step.visual` — required on every non-minor step except `change` steps whose point
  is the edit itself; `symptoms` for the first step, `layers` for order/priority
  values, `flow` for chains of events (see analyzer-prompt.md → Visuals).
- Every non-minor step except `symptom`/`verification` quotes code; a `constraint`/
  `cause` step quotes the BASE code that makes it true.
- `step.minor` — true for a step that exists only for completeness (a supporting
  one-liner); minor steps are listed in the summary, never shown as their own screen.
- `narration` (the field that already existed) is written to be **heard**, not read:
  plain language, no identifiers, 2–4 sentences. `say` is the short on-screen version
  of the same idea, not a duplicate of the narration.

## When to use `visual.map`

The dependency/data-flow map is expensive attention — reserve it for steps that are
actually about structure: how a value gets from A to B, a new/removed connection
between files. Most steps (a single-file logic change, a symptom, a verification
step) use `flow`/`symptoms`/`layers`/`try` or no visual at all. As a rule of thumb,
no more than ~30% of a walkthrough's steps should use `map` — if more do, the PR is
probably being explained file-by-file instead of by reasoning (see below).

## Trust tags

Every step's `tag` and every annotation's `annotationTag` must be one of `fact`
(visible in diff/code/comment/test), `commit_history` (stated in a commit message),
`inferred` (the analyzer's own reading of the code — say so, don't present it as
fact), or `unverified` (a scenario nobody has run). A removed guard or attribute
being "the fix" is a `fact` once the analyzer has traced *what* now runs differently
because it's gone (rule 7 in analyzer-prompt.md) — never label that "redundant".

## Large PRs and PRs without a description

- Large PRs (see step budget above): focus steps on the mechanism the PR changes;
  push everything else to `skippedHunks`. Coverage must still be complete — "focused"
  means fewer *steps*, not fewer *hunks accounted for*.
- No PR description: base steps on commits and diff, tag more steps `inferred` or
  `commit_history` rather than `fact`, and say so in a step's `notes` when a claim is
  a best guess. Never invent a symptom or a motivation that isn't backed by a commit
  message or the code itself.

## GitHub is a companion, not a replacement

(Decision from user discussion, recorded here since it shapes what the product does
and does not need to build.) Approve, request-changes and reviewer discussion stay in
GitHub — nobody will come here to do those. The walkthrough's job is to get someone
from a GitHub PR link to understanding, and back to GitHub to act. This is why
`CodeFold`'s "open file ↗" links straight to the file on GitHub at the right sha
(see ST6a), and why posting a review comment (deferred item) targets a specific
diff line rather than inventing a parallel review UI.

## What `quality.ts` actually checks

Warnings only, computed from a finished `Walkthrough` (optionally the prompt-hunk
count, for the step-budget check):

- Identifier-looking text (backticks, `camelCase`/`PascalCase`, `snake_case`, a `.ts`/
  `.tsx` extension, a `/` path segment) inside `plain.title/problem/fix`,
  `step.headline`, or `step.say`.
- `step.headline` longer than 9 words.
- `step.say` with more than two sentences.
- A non-minor step with no `visual` (`change` and `verification` exempt) —
  `missing-visual`.
- A non-minor step quoting no code (`symptom` and `verification` exempt) —
  `step-without-code`.
- Step count outside the size-based budget above.
- More than ~30% of steps using `visual.map`.
- A step whose beats quote a test/snapshot file (the prompt says never to).
- `meta.analyzer` claiming `"bob-shell"` with no `meta.run` attached (the backend
  always fills `run` for a real Bob Shell call — its absence means something upstream
  forgot to attach it, not that the run was free).
