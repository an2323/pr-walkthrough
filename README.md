# PR Walkthrough

> **IBM Bob 2.0 Hackathon — Sep 25–27, 2026**

An interactive PR walkthrough tool. Given a GitHub PR URL, it analyses the full repository
with IBM Bob Shell and produces a narrated, annotated route through the reviewer's
reasoning — not just a diff summary, but *why* the code changed, and — where the change is
visible in a running app — *proof*, not just Bob's own reading of the diff.

**Public demo (static):** https://pr-walkthrough-bob.vercel.app
**Source:** https://github.com/an2323/pr-walkthrough

## Problem

AI-generated PRs have pushed code review times up ~441% (Faros AI, 2026). Existing review
bots summarise *what* changed. This tool explains *why* — and checks its own explanation
against the running app instead of asking the reviewer to just trust it.

## Quick start

```bash
# Prerequisites: Node ≥ 18, pnpm ≥ 8
pnpm install
pnpm --filter @pr-walkthrough/shared build
ANALYZER=cached pnpm dev
# Server: http://localhost:3000
# Viewer: http://localhost:5173
# Open   http://localhost:5173/excalidraw/excalidraw/10943
```

Copy `.env.example` → `.env` and fill keys as needed. Secrets stay on the server; never in
the browser.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANALYZER` | `cached` | `cached` \| `bob` |
| `BOB_API_KEY` | — | Inference-scoped key for `bob run` (paid) |
| `BOB_BUDGET_USD` | `28` | Stage budget guard — refuses a run that could push the total over this |
| `MAX_COST` / `REPAIR_MAX_COST` | `8` / `1` | Per-run Bobcoin caps for a fresh analysis / its one repair attempt |
| `VERIFY_SHOTS` | `1` | Set `0` to skip the before/after screenshot verifier after analysis |
| `VERIFY_MAX_COST` | `2` | Bobcoin cap for one verifier run (`pr-verifier` mode) |
| `VERIFY_ABLATION` | `1` | Set `0` to skip the $0 evidence check that follows a confirmed verifier run |
| `REVISE_MAX_COST` | `1` | Bobcoin cap for one evidence-based revision pass (`bob:revise`) |
| `GITHUB_TOKEN` | — | Read token for PR metadata / clones |
| `GITHUB_TOKEN_WRITE` | — | Fine-grained PAT for posting comments to the demo PR |
| `GITHUB_DEMO_REPO` / `GITHUB_DEMO_PR` | `an2323/excalidraw` / `1` | Demo fork + PR for ST6d comments |
| `GITHUB_DEMO_SOURCE` | `excalidraw/excalidraw#10295` | Which analysed PR the demo PR mirrors — only that one can post |
| `ELEVENLABS_API_KEY` | — | Narration TTS (optional; Web Speech fallback) |
| `TTS_GENERATE` | `0` | Set `1` to generate missing narration audio on demand (spends credits); `tts:pregen` ignores this |
| `GIT_CACHE_DIR` | `/tmp/pr-walkthrough-repos` | Clone + worktree cache |
| `PORT` | `3000` | Server port |

## Demo mode (zero cost)

```bash
ANALYZER=cached pnpm dev
```

Pre-generated walkthroughs: `data/walkthroughs/excalidraw/excalidraw/{10295,8340,10943}.json`.
Recorded analysis replays: landing page → **Watch the analysis →** (SSE from `data/events/…`;
#10943 has none — its original run hit a disk-full incident right as it tried to save one,
see `docs/cost-log-stage2.md`).
Before/after screenshots on the start screen: `data/shots/…`, highlight boxes baked into the
PNGs by the backend (`packages/server/src/shots/annotate.ts`).

### Static public build

```bash
pnpm build:static
# local preview: npx serve packages/web/dist
```

Deploys with `npx vercel deploy --prod` from `packages/web/dist` (project `pr-walkthrough`,
alias `pr-walkthrough-bob.vercel.app`) — see "Redeploy" under ST6f in `pr-walkthrough-plan.md`
for the exact commands. Excalidraw PRs only; Outline's licence is unverified and
`export-static.ts` refuses to publish it even by accident.

## How we used IBM Bob 2.0

| Feature | Where |
|---|---|
| **Plan mode** | `pr-walkthrough-plan.md` (architecture, ST1–ST12) and `~/.claude/plans/bob-transient-pine.md` (viewer redesign) |
| **Agent mode** | Implemented the full pipeline end to end: monorepo, analyzer, validation, live jobs, GitHub round-trip, the evidence loop, the viewer redesign |
| **Bob Shell** | `BobShellAnalyzer` runs `bob run --format stream-json --mode pr-walkthrough` headless in a throwaway checkout. Real numbers per PR in `docs/cost-log-stage2.md` |
| **Custom mode — analyzer** | `pr-walkthrough` (`groups: [read, subagent]`), written into `<checkout>/.bob/custom_modes.yaml` — read-only analysis, no shell |
| **Custom mode — verifier** | `pr-verifier` (`groups: [read, edit, execute]`) — Bob starts nothing itself (the backend starts the app at BASE and HEAD); Bob writes and runs a Playwright script that reproduces the bug and prints a pass/fail signal, then the backend re-runs that SAME script itself before trusting it |
| **Subagents** | `explore` sub-agents during analysis (varies by PR — see the cost log) |
| **Resume** | Two uses: fixing schema/verbatim failures (`bob run --resume`), and — new this stage — **revising the walkthrough from measured evidence**: the backend re-runs the verifier's own script against the PR's changes applied one at a time to BASE (an ablation), and resumes the *same analysis session* with that table, asking Bob to rewrite only the steps its own evidence contradicts. On #10943 this caught and fixed a wrong causal claim ("removing X alone won't work, because…") that Bob had stated as fact — see `pr-walkthrough-plan.md`'s Sub-Task 12 |
| **AGENTS.md** | Schema contract, budget rules, tool constraints for the workspace |
| **Document understanding** | Golden walkthrough JSON, `walkthrough.ts` schema, and analyzer prompt as few-shot context |

### The evidence loop, briefly

A walkthrough's steps make causal claims ("this change fixes the bug because…"). Reading
code to explain *why* something works is exactly where an LLM is most likely to sound
confident and be wrong — CSS/layout mechanics especially. So for a PR whose fix is visible
in a running app (currently: Excalidraw), the pipeline doesn't stop at Bob's prose:

1. Bob writes one script that reproduces the bug against *any* URL it's given and reports
   `bugPresent: true/false` from a concrete signal it chooses (a bounding box, a DOM
   attribute, computed CSS) — not from which build happens to be running.
2. The backend **does not trust Bob's claim that it works** — it re-runs that script itself
   against BASE and HEAD and requires `true`/`false` respectively before using it for
   anything.
3. Once confirmed, the backend applies the PR's hunks to BASE **one at a time and all-but-
   one**, in disposable throwaway checkouts, and reruns the same script each time — for $0,
   no Bob involved. This says which changes the fix actually *needs*.
4. If that table contradicts something Bob wrote, the *same analysis session* is resumed
   with the table and asked to fix only the contradicted steps — using measured facts, not
   asked to guess again.

See `packages/server/src/verify/{bob-verifier,ablation}.ts` and
`packages/server/scripts/bob-revise.ts`.

### bob_sessions/ (submission requirement)

PNG screenshots of significant Bob sessions go in `bob_sessions/`, named:

`{teamname}_task{nn}_{short_description}.png`

Checklist (take as you go — do not leave empty at submit):

- [ ] Plan / architecture session
- [ ] Custom mode + first `bob run` on #10295
- [ ] Quality iteration (ST10) / resume repair
- [ ] Live analysis progress screen (replay is ok)
- [ ] Screenshot verifier (`pr-verifier` mode) taking before/after shots
- [ ] Evidence-based revision (`bob:revise`) correcting a step from the ablation table
- [ ] Comment posted from the viewer to the demo PR

## Licence

MIT. Public demo data: Excalidraw only (MIT). Outline JSON in the repo is private test data
and is **not** deployed.
