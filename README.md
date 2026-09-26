# PR Walkthrough

> **IBM Bob 2.0 Hackathon — Sep 25–27, 2026**

An interactive PR walkthrough tool. Given a GitHub PR URL, it analyses the full repository with IBM Bob Shell and produces a narrated, annotated route through the reviewer's reasoning — not just a diff summary, but *why* the code changed.

**Public demo (static):** https://pr-walkthrough-bob.vercel.app

## Problem

AI-generated PRs have pushed code review times up ~441% (Faros AI, 2026). Existing review bots summarise *what* changed. This tool explains *why*.

## Quick start

```bash
# Prerequisites: Node ≥ 18, pnpm ≥ 8
pnpm install
pnpm --filter @pr-walkthrough/shared build
ANALYZER=cached pnpm dev
# Server: http://localhost:3000
# Viewer: http://localhost:5173
# Open   http://localhost:5173/excalidraw/excalidraw/10295
```

Copy `.env.example` → `.env` and fill keys as needed. Secrets stay on the server; never in the browser.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANALYZER` | `cached` | `cached` \| `bob` |
| `BOB_API_KEY` | — | Inference-scoped key for `bob run` (paid) |
| `BOB_BUDGET_USD` | `20` | Stage budget guard |
| `GITHUB_TOKEN` | — | Read token for PR metadata / clones |
| `GITHUB_TOKEN_WRITE` | — | Fine-grained PAT for posting comments to the demo PR |
| `GITHUB_DEMO_REPO` | `an2323/excalidraw` | Demo fork for ST6d comments |
| `GITHUB_DEMO_PR` | `1` | Demo PR number |
| `ELEVENLABS_API_KEY` | — | Narration TTS (optional; Web Speech fallback) |
| `GIT_CACHE_DIR` | `/tmp/pr-walkthrough-repos` | Clone + worktree cache |
| `PORT` | `3000` | Server port |

## Demo mode (zero cost)

```bash
ANALYZER=cached pnpm dev
```

Pre-generated walkthroughs: `data/walkthroughs/excalidraw/excalidraw/{10295,8340}.json`.  
Recorded analysis replays: landing page → **Watch the analysis →** (SSE from `data/events/…`).  
Before/after screenshots on step 1 of #10295: `data/shots/…` (highlight boxes drawn by the viewer).

### Static public build

```bash
pnpm build:static
# then: cd packages/web/dist && npx vercel link --yes --project pr-walkthrough && npx vercel deploy --prod --yes
# alias: npx vercel alias set <deployment-url> pr-walkthrough-bob.vercel.app
```

## How we used IBM Bob 2.0

| Feature | Where |
|---|---|
| **Plan mode** | Full plan in `pr-walkthrough-plan.md` — architecture, sub-tasks, verify steps |
| **Agent mode** | Implemented ST1–ST6g: monorepo, analyzer, validation, viewer v2, live jobs, GitHub round-trip, static demo, shots UI |
| **Bob Shell** | `BobShellAnalyzer` runs `bob run --format stream-json --mode pr-walkthrough` headless in a throwaway checkout. Live numbers in `docs/cost-log.md` / `docs/cost-log-stage2.md` (e.g. #10295 ~174 s / ~$3; stage-2 quality iterations ~$10.20 of $20) |
| **Custom mode** | Backend writes `pr-walkthrough` into `<checkout>/.bob/custom_modes.yaml` (`groups: [read, subagent]`) — read-only analysis |
| **Subagents** | `explore` sub-agents during analysis (#10295: 2, #8340: 4) |
| **Resume** | Validation repairs via `bob run --resume <task_id>` (e.g. #8340 repair ~$0.34) |
| **AGENTS.md** | Schema contract, budget rules, tool constraints for the workspace |
| **Document understanding** | Golden walkthrough JSON, `walkthrough.ts` schema, and analyzer prompt as few-shot context |

### bob_sessions/ (submission requirement)

PNG screenshots of significant Bob sessions go in `bob_sessions/`, named:

`{teamname}_task{nn}_{short_description}.png`

Checklist (take as you go — do not leave empty at submit):

- [ ] Plan / architecture session
- [ ] Custom mode + first `bob run` on #10295
- [ ] Quality iteration (ST10) / resume repair
- [ ] Live analysis progress screen (replay is ok)
- [ ] Comment posted from the viewer to the demo PR

## Licence

MIT. Public demo data: Excalidraw only (MIT). Outline JSON in the repo is private test data and is **not** deployed.
