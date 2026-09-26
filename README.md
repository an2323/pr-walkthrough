# PR Walkthrough

> **IBM Bob 2.0 Hackathon — Sep 25–27, 2026**

An interactive PR walkthrough tool. Given a GitHub PR URL, it analyses the full repository with IBM Bob Shell and produces a narrated, annotated route through the reviewer's reasoning — not just a diff summary, but *why* the code changed.

## Problem

AI-generated PRs have pushed code review times up ~441% (Faros AI, 2026). Existing review bots summarise *what* changed. This tool explains *why*.

## Quick start

```bash
# Prerequisites: Node ≥ 18, pnpm ≥ 8
pnpm install
pnpm --filter @pr-walkthrough/shared build
pnpm dev
# Server: http://localhost:3000
# Viewer: http://localhost:5173
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANALYZER` | `cached` | `cached` \| `bob` \| `llm` |
| `GITHUB_TOKEN` | — | GitHub personal access token |
| `GIT_CACHE_DIR` | `/tmp/pr-walkthrough-repos` | Where repos are cloned |
| `PORT` | `3000` | Server port |

## Demo mode (zero cost)

```bash
ANALYZER=cached pnpm dev
# Open http://localhost:5173/excalidraw/excalidraw/10295
```

Pre-generated walkthroughs are in `data/walkthroughs/`.

## How we used IBM Bob 2.0

| Feature | Where |
|---|---|
| Plan mode | Architecture design, this plan |
| Agent mode | Implementing each sub-task |
| Subagents | Inside Bob Shell analysis runs for parallel symbol searches |
| Bob Shell | `BobShellAnalyzer` — core analyzer, non-interactive |
| AGENTS.md | Workspace instructions for Bob Shell read-only access |
| Parallel tasks | Session A (server) + Session B (viewer) ran simultaneously |
| Custom skill | `/walkthrough <PR url>` for interactive IDE use |
| Rollback | Used when sub-task implementations broke tests |
| Document understanding | Bob read the golden JSON and schema during planning |

## Licence

MIT. Demo data: Excalidraw (MIT). See `docs/cost-log.md` for Bobcoin usage.
