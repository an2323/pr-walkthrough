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
| **Plan mode** | Produced the full implementation plan (`pr-walkthrough-plan.md`) — architecture, sub-task ordering, verify steps |
| **Agent mode** | Implemented every sub-task (ST1–ST6b): monorepo scaffold, diff parser, validation pipeline, GitHub adapter, React viewer, TTS narration |
| **Bob Shell** | `BobShellAnalyzer` invokes `bob run --format json --mode pr-walkthrough` headless; the analyzer reads the full repo checkout and returns a structured `Walkthrough` JSON. Confirmed live on excalidraw/excalidraw#10295 (174 s, 43 tool calls) |
| **Custom mode** | The backend writes a `pr-walkthrough` mode to `<checkout>/.bob/custom_modes.yaml` with `groups: [read]` before each Bob Shell run — sandboxing the analyzer to read-only file access with no shell, no edits, no network |
| **AGENTS.md** | `AGENTS.md` at the workspace root carries the schema contract, budget rules, and tool constraints; Bob Shell reads it at the start of every analysis run |
| **Document understanding** | Bob read and extracted structure from the prototype viewer HTML, the golden walkthrough JSON, and the Zod schema during planning and implementation |

## Licence

MIT. Demo data: Excalidraw (MIT). See `docs/cost-log.md` for Bobcoin usage.
