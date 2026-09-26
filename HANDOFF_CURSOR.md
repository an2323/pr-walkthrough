# Handoff — continue "PR Walkthrough" (IBM Bob 2.0 Hackathon)

Paste this whole file as your first message to Cursor. It has run out of budget in
Claude Code and the user is switching tools mid-task; nothing is broken or half-done —
the working tree is clean, last commit `c8e5f9e`.

## Read first, in this order

1. `AGENTS.md` — project overview, repo layout, secrets handling. **Note:** its
   "Bob Shell analyzer — read-only access rules" section is stale (describes an older
   `groups: [read]` / `--format json` design) — the real, current design is in
   `pr-walkthrough-plan.md` under "## Bob Shell Analyzer Design" and in the actual code
   (`packages/server/src/analyzer/bob-shell.ts`). Trust the plan + code over that one
   AGENTS.md section.
2. `pr-walkthrough-plan.md` — the full plan with a status on every sub-task (ST1…ST10).
   Skim for `[x] done`, `[ ]  pending`, `[-]` in progress, `✂ cut`. Read ST6c, ST6d, ST6e
   (cut), ST6f, ST7, ST10 in full — they're the current front line.
3. `docs/cost-log-stage2.md` — every paid Bob Shell run so far, with cost.

## Hard constraints — do not violate these

- **Deadline: Sep 27, 15:00 UTC.**
- **Never run real Bob Shell (`bob run` / `ANALYZER=bob`) or call ElevenLabs without the
  user's explicit go-ahead in chat, given right before that specific run.** A cap
  approved earlier does not carry over to a new run. Use `ANALYZER=cached` for all
  development and verification.
- **Stage-2 Bobcoin budget cap is $20 total, ~$10.20 already spent** (see
  `docs/cost-log-stage2.md`; guard code in `packages/server/src/analyzer/budget.ts`,
  `BOB_BUDGET_USD`). Any new paid run needs the user's yes AND must fit under the
  remaining ~$9.80, checked before starting.
- **Secrets only in `.env`** (gitignored). Never print, log, or paste key/token values.
  `.env.example` documents every var and what scope/permission it needs.
- Commit after each coherent change; don't batch unrelated things into one commit.
  The project's own convention has been small, descriptive commits (see `git log`).

## Where things stand right now

**Done and committed (do not redo):**
- ST1–ST6b: monorepo, viewer, git workspace, validation, `CachedAnalyzer` +
  `BobShellAnalyzer`, GitHub adapter, viewer v2 UX, ElevenLabs narration pipeline.
- ST10 (quality iteration): 2 prompt-edit iterations on #10295 converged (8→1 quality
  warnings). `data/walkthroughs/excalidraw/excalidraw/{10295,8340}.json` are valid and
  promoted. #9403 is deferred — a bug in *our own* stream-json JSON reconstruction on
  its repaired (~40KB) response, not a Bob output-quality problem; not blocking.
- ST6c (live analysis + progress screen): `POST /api/analyze` returns `{jobId}` at once;
  SSE streams normalized `ProgressEvent`s (`packages/shared/src/progress.ts`) built from
  Bob's raw `stream-json` events (`packages/server/src/analyzer/progress-normalizer.ts`).
  `GET /api/runs/:owner/:repo/:number/events?speed=N` replays a committed recording
  (`data/events/excalidraw/excalidraw/{10295,8340}.ndjson`) at $0 — this is what the
  viewer's "Watch the analysis →" link uses. Viewer: `ProgressScreen.tsx`. Cost guards
  are in `packages/server/src/api/jobs.ts` / `routes.ts` (one paid job at a time, a
  cached PR is served without a new run unless `force: true`).
- ST6e (agent-verifier / "Try it in the app"): **cut deliberately.** Replaced by two
  manual before/after screenshots (still need to be taken — see ST9 below). The
  "Try it" chapter is hidden via `SHOW_TRY_IT = false` in `packages/web/src/features.ts`
  — do not remove the code, just flip the flag back if this decision ever reverses.
- ST6d groundwork: forked `excalidraw/excalidraw` to `an2323/excalidraw` and opened
  **[an2323/excalidraw#1](https://github.com/an2323/excalidraw/pull/1)**, which
  re-creates #10295 exactly (`demo-10295-base`/`demo-10295-head` branches point at the
  *same* base/head SHAs the cached walkthrough already uses — no drift). This fork
  exists so the demo can post review comments without touching the real, already-merged
  PR by a stranger, and so the write token is scoped to a repo we control. It is NOT for
  judges to "test the PR" on — it's the target of the comment/question round-trip
  feature. `.env.example` has `GITHUB_DEMO_REPO=an2323/excalidraw`,
  `GITHUB_DEMO_PR=1`, `GITHUB_TOKEN_WRITE=` (empty, user is creating this token now).

**In progress / next up, in this order:**

1. **ST6d implementation** (the fork/PR is ready, just needs the token wired in):
   - Check whether the user has put a value into `GITHUB_TOKEN_WRITE` in `.env` yet. If
     not, ask them — this feature is unusable without it (falls back to the existing
     copy-to-clipboard button, which must keep working).
   - Token scope needed (already documented in `.env.example`): fine-grained PAT limited
     to `an2323/excalidraw`, **Pull requests: Read and write** (line comments,
     `POST /repos/{o}/{r}/pulls/{n}/comments`, `commit_id` = head SHA) + **Issues: Read
     and write** (general/out-of-diff comments go through
     `POST /repos/{o}/{r}/issues/{n}/comments` — a PR is an "issue" for that endpoint).
   - Wire "Your review" screen (`packages/web/src/SummaryScreen.tsx`): a comment/question
     button that posts through a new backend endpoint (backend-only token, never sent to
     the browser) instead of only copy-to-clipboard. Should-haves (do if time allows,
     skip otherwise): draft review with Submit (Comment/Approve/Request changes) via
     `POST /pulls/{n}/reviews`; a bot comment linking back to the walkthrough.
   - Full design is written out under "Sub-Task 6d" in `pr-walkthrough-plan.md` — follow
     it, update its `**Status:**` line and add an "As built" note when done, the way
     ST6c's entry does.
   - Verify: post a line comment and a question from the viewer, confirm they land on
     an2323/excalidraw#1 at the right line; with the token unset, confirm the UI falls
     back to copy and nothing throws.

2. **ST6f — public demo on Vercel** (not started): static build of the viewer (JSON +
   narration mp3 + screenshots as static files, no backend), Excalidraw PRs only
   (Outline's licence is unverified — never put it in the public demo). Live analysis
   and GitHub posting are hidden in this build; the video covers them instead. Design is
   under "Sub-Task 6f" in the plan.

3. **ElevenLabs narration regeneration — deliberately deferred to the very end** (a
   Sep 26 decision, see ST7 in the plan): #10295's narration text changed during ST10 and
   is now stale; #8340 has no narration yet. Do this only once ST6c/6d/6f/ST7 wording is
   final, and only with the user's explicit go-ahead (it spends ElevenLabs credits).
   `pnpm --filter @pr-walkthrough/server tts:pregen <owner/repo#number>`.

4. **Paid runs waiting on the user's yes** (ask before running, check budget first):
   - ST10 confirmation run on #8340 (~$1–2) — does the prompt-quality fix generalize.
   - #9403 retry — only after root-causing the stream-json reconstruction bug in
     `findWalkthroughInEvents` (`packages/server/src/analyzer/bob-shell.ts`); otherwise
     it'll just fail the same way again for another $1–2.

5. **ST8 — `bob_sessions/` screenshots.** ⚠️ Currently **empty**. This is a submission
   eligibility requirement (PNG per significant task, named
   `{teamname}_task{nn}_{short_description}.png`). Flag this to the user early if it's
   still empty — don't let it become a last-minute blocker.

6. **ST9 — README, demo video, final polish** (not started): two manual before/after
   screenshots of #10295 (excalidraw at BASE vs HEAD, sidebar open — replaces the cut
   ST6e), then a demo video: before/after → walkthrough with narration → live-analysis
   progress screen → comment landing in GitHub. README needs a "How we used Bob 2.0"
   section (table already drafted in ST8's plan section) with real numbers from the cost
   logs (subagents, `--resume`, cost/duration).

## Verification habits already in place — keep following them

- `pnpm --filter @pr-walkthrough/shared build` after touching `packages/shared`.
- `pnpm --filter @pr-walkthrough/server test`, and `lint`/`tsc --noEmit` for both
  `server` and `web`, `pnpm --filter @pr-walkthrough/web build` — run all of these before
  considering a change done.
- Start the stack with `ANALYZER=cached pnpm dev` and check in a browser at both desktop
  and ~375px width; no console errors.
- Every paid Bob Shell run gets a row in `docs/cost-log-stage2.md` (date, PR, mode,
  max-cost, actual cost, duration, tool calls, subagents, repairs, valid, notes) —
  match the existing table's columns exactly.
