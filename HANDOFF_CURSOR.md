# Handoff — continue "PR Walkthrough" (IBM Bob 2.0 Hackathon)

Paste this whole file as your first message to Cursor. Claude Code is hitting its limit again;
the user is switching tools mid-task. Working tree is clean as of commit `baf35e5`, deadline
**Sep 27, 15:00 UTC** — check the actual time, this handoff was written at ~09:10 UTC (~5h50m left).

## Hard constraints — do not violate these

- **Never run real Bob Shell (`bob run` / `ANALYZER=bob`) or call ElevenLabs without the user's
  explicit go-ahead in chat, given right before that specific run.** Approval for one run doesn't
  carry to the next.
- **Stage-2 Bobcoin budget cap is $28, ~$25.01 already spent — only ~$2.99 left.** Check
  `docs/cost-log-stage2.md` and `packages/server/src/analyzer/budget.ts`'s `assertBudget` before
  proposing ANY paid run; a single further mistake could exceed the cap. Prefer $0 fixes.
- **Secrets only in `.env`** (gitignored). Never print, log, or paste key/token values.
- Small, descriptive commits (see `git log`), attribution line per this repo's convention (check
  the last few commits for the exact `Co-Authored-By` wording your tool should use).
- `pnpm --filter @pr-walkthrough/server test`, `lint` (server+web), `pnpm --filter
  @pr-walkthrough/web build` before considering anything done.

## Read first

1. `pr-walkthrough-plan.md` — Sub-Task 12 (the "evidence loop": repro script + ablation +
   evidence-based revision) and the redesign steps folded into
   `~/.claude/plans/bob-transient-pine.md` (P1 viewer redesign, now done).
2. `docs/cost-log-stage2.md` — every paid run this stage, with cost.
3. `AGENTS.md` — still describes an OLDER analyzer design (`groups:[read]`, `--format json`);
   trust the plan + code instead (`packages/server/src/analyzer/bob-shell.ts`,
   `packages/server/src/verify/*.ts`).

## What's done

- **ST1–ST12 (evidence loop)**: full pipeline — analysis → validation (incl. new
  backend-computed line numbers/`+`/`-` change markers/stitched-quote detection,
  `validation/line-numbers.ts`) → a screenshot verifier (Bob writes a `repro.cjs` that the
  backend independently confirms true@BASE/false@HEAD before trusting it) → a $0 ablation
  (`verify/ablation.ts`: apply the PR's hunks to BASE one-at-a-time / all-but-one, rerun the
  confirmed script) → an evidence-based revision pass (`bob-revise.ts`) that resumes the
  original Bob session with the ablation table and fixes only the steps it contradicts.
  Demonstrated end-to-end on **#10943** (see `pr-walkthrough-plan.md` ST12 and the commit log).
- **Viewer redesign (P1, all done)**: dark theme is now the default (not OS-dependent); two-column
  step layout (story left, code right ≥1024px) with real line numbers and diff-fact-based
  `+`/`-` colors instead of the analyzer's own (unreliable) `kind`; screenshots never upscale past
  their natural size, and now **auto-crop** to the highlighted region when it's a small fraction
  of a large screenshot (`verify/highlights.ts`'s `maybeCropRegion`, wired into
  `shots/annotate.ts` and `scripts/annotate-shots.ts --no-crop` to disable); landing page rewritten
  with real per-PR numbers fetched live, not hand-written blurbs; flow diagrams no longer clip in
  the narrow story column.
- **#10295 regenerated** with the current prompt (was on an older, pre-ST12 prompt) — took 3
  attempts (2 failed: one hit the still-open #9403-style JSON-extraction bug on a large response,
  one had a stitched-code quote a targeted `--resume` then fixed). Its original manual before/after
  shots were restored (the fresh analysis run doesn't call the verifier by itself). Old version
  backed up at `data/walkthroughs/archive/10295.pre-st12-zindex.json`.
- **Narration rule**: narration must never mention how a claim was checked ("ablation",
  "confirms", etc.) — that belongs in `say`/`notes`. Added to the analyzer prompt, `bob-revise.ts`'s
  own prompt, and a new `checkQuality` warning (`narration-mentions-process`). Hand-fixed the two
  PRs already affected (#10943's evidence mentions, #8340's raw backticked identifiers — #8340
  predates the no-identifiers rule entirely).
- **README** rewritten with current env vars, the evidence-loop explanation, updated
  `bob_sessions/` checklist.
- **Deployed** to https://pr-walkthrough-bob.vercel.app (static build, `pnpm build:static` then
  `vercel deploy --prod` from `packages/web/dist` — **always run `npx vercel link --yes --project
  pr-walkthrough` again first**, since `vite build` wipes `dist/.vercel` on every build and a bare
  `vercel deploy` will silently create/deploy to a NEW project instead of aliasing the right one —
  this happened once already tonight, caught and fixed).

## In progress — pick this up first

**#10943's before/after screenshots don't show the bug.** The PR's real title is "arrowhead
picker overflowing viewport", but at every viewport size tested (1280×800 down to mobile widths,
and down to absurdly short heights) the picker does **not** visibly overflow in the scenario Bob's
verifier script uses (draw an arrow in the canvas center, open the arrowhead style picker) —
confirmed by direct measurement (`overflowsRight`/`overflowsBottom` both false almost everywhere).
The underlying bug is real and measured (BASE: `.picker` is `position: absolute` with no Radix
`data-side` attribute; HEAD: `static` + `data-side` present — this is what the ablation/evidence
loop actually verified), but it's a **structural** DOM fact, not something guaranteed to produce a
dramatic visible edge-of-screen moment in this interaction path.

Already tried and ruled out (all $0, no Bob spend): plain viewport resizing in every direction;
auto-cropping the screenshot to the highlighted area (implemented, committed, helps legibility but
doesn't create an edge that isn't there). **Next idea, not yet tried**: the component's SCSS has an
explicit `[dir="rtl"]` rule — Excalidraw's properties panel docks on the opposite side in an RTL
language (e.g. Arabic, `ar-SA`, switchable via the in-app language dropdown or by setting
`document.documentElement.dir`/the app's language atom before interacting), which could plausibly
put the picker's trigger near a real edge. A `$0` Playwright experiment (start BASE+HEAD via
`packages/server/src/verify/app-servers.ts` + `recipeFor("excalidraw","excalidraw")`, switch to
Arabic, repeat the draw-arrow-then-open-picker scenario, check `getBoundingClientRect()` against
`innerWidth`) was queued when this session got interrupted — pick it up from there.

**User's explicit decision point (ask them, don't just proceed):** if RTL (or another $0 idea) still
doesn't produce a visible difference, the options are — (a) drop the before/after screenshots for
#10943 and rely on the text + evidence badges only (cheapest, most honest), (b) spend ~$0.3–0.6 of
the ~$2.99 left asking Bob itself to find a genuinely visible repro (risk: it already tried once and
produced the same non-visible scenario), or (c) accept the current cropped screenshot as-is with
honest framing that it demonstrates the structural fix, not a dramatic visual one. The user was
mid-decision on this when this session ran low — resume by asking them directly rather than picking
for them.

## Remaining after that

1. **`bob_sessions/` — still empty except a placeholder README.** This is a hard submission
   requirement (PNG per significant Bob session, `{teamname}_task{nn}_{short_description}.png`) and
   can only be done by the user (screenshots of their own Bob IDE/Shell usage) — flag it to them
   early and often, it's the single biggest risk to a rejected submission right now.
2. **ElevenLabs narration audio** — deliberately deferred to the very end so text isn't re-recorded
   twice; text is now final for #10943/#10295, #8340 still has pre-ST12 `say`/`headline` identifier
   warnings (not narration — those are fixed) that weren't in scope of tonight's narration cleanup.
   3 sample sentences were already generated and sent to the user for a voice check earlier — ask
   before generating the rest (spends ElevenLabs credits), and regenerate the static Vercel build +
   redeploy afterward (`pnpm build:static && cd packages/web/dist && npx vercel link --yes --project
   pr-walkthrough && npx vercel deploy --prod --yes && npx vercel alias set <new-url>
   pr-walkthrough-bob.vercel.app`).
3. **Demo video**: before/after (or the honest structural framing decided above for #10943) →
   walkthrough with narration → live-analysis progress screen → comment landing in GitHub (ST6d,
   already built — demo PR is `an2323/excalidraw#1`).
4. **Submission** before 15:00 UTC.

## Verification habits already in place

- `ANALYZER=cached pnpm dev`, check in a browser at desktop width and ~375px; no new console
  errors (the dev server has been running a long time this session — some console entries are
  stale from hours ago, timestamped; only treat NEW ones after your own changes as real).
- Every paid Bob Shell run gets a row in `docs/cost-log-stage2.md` — match the existing columns.
- `packages/server/scripts/annotate-shots.ts <owner/repo#n> [--no-crop]` re-renders shots at $0
  from already-captured raw PNGs + stored highlight coordinates — no need to re-run the verifier
  just to tweak crop/label rendering.
