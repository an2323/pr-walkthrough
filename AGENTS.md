# AGENTS.md — Workspace instructions for Bob Shell

## Project overview

This is **PR Walkthrough**, a tool that analyses a GitHub pull request with access to the full repository and produces an interactive, narrated walkthrough for the reviewer.

## Repo layout

```
packages/
  shared/     TypeScript types (Walkthrough schema) + Zod validators + hunk-id parser
  server/     Node.js + Express backend: git workspace, diff parser, validation, analyzer, API
  web/        React viewer (Vite): route rail, graph, beats, code blocks, TTS narration
data/
  walkthroughs/  Pre-generated JSON files (served by CachedAnalyzer in demo mode)
docs/
  walkthrough.ts         Authoritative schema (source of truth)
  analyzer-prompt.md     Runtime prompt template for the analyzer
  bob-brief/examples/    Golden walkthrough JSON for outline/outline#13673
  bob-brief/prototypes/  Working single-file prototype viewer (HTML)
bob_sessions/   Hackathon screenshots (required for submission)
```

## Running in development

```bash
pnpm install
pnpm --filter @pr-walkthrough/shared build   # build shared types first
pnpm dev                                      # starts server (port 3000) + web (port 5173)
```

## Bob Shell analyzer — read-only access rules

When Bob Shell is invoked as the analyzer (`ANALYZER=bob`), it runs headless via `bob run` in the cached repository checkout (never in this repo). See "Bob Shell Analyzer Design" in `pr-walkthrough-plan.md`; reference implementation: `packages/server/scripts/bob-spike.ts`.

- `bob run` **pre-approves every tool of the active mode**. The default `agent` mode can edit files and run shell commands, so the analyzer must always run with `--mode pr-walkthrough`.
- The `pr-walkthrough` custom mode is written by the backend to `<checkout>/.bob/custom_modes.yaml` with `groups: [read]`: read and search files only, no edit, no shell.
- Without shell there is no `git`; the backend writes `<checkout>/.walkthrough/` with `base/<path>` (changed files at BASE), `pr.diff`, and `commits.txt`.
- Always pass `--max-cost` and `--disable-mcp`; the process has a 10-minute timeout.
- The analyzer receives the filled prompt on stdin and must return ONLY a JSON object matching the `Walkthrough` type, without `hunks`, `coverage`, `pr`.
- The backend extracts the walkthrough from the `--format json` envelope and fills `pr`, `hunks`, `coverage` before validation.
- `--hide-intermediary-output`, `--allowed-tools`, `--yolo` are not `bob run` flags — do not use them.

## Bobcoin budget discipline

- Never invoke `BobShellAnalyzer` during verification of ST1–ST6 — use `ANALYZER=cached` instead
- Always check Bobcoin balance before starting a new Bob Shell analysis run
- Generate the smallest demo PR first (`excalidraw/excalidraw#10295`, +19 −7)
- Validate output immediately after generation before spending on the next PR
- Log every paid run (mode, duration, Bobcoins before/after, valid?) in `docs/cost-log.md`

## Schema contract

- The **analyzer** decides: order, meaning, narration, annotations, graph, open questions
- The **backend** computes: hunks, coverage, verbatim line checks
- The analyzer must NOT invent hunk ids — they are provided as input in the prompt

## Key files to read before making changes

- `packages/shared/src/walkthrough.ts` — all TypeScript types
- `packages/shared/src/schema.ts` — all Zod validators
- `docs/bob-brief/examples/outline-13673.walkthrough.json` — golden example output
- `pr-walkthrough-plan.md` — full implementation plan with verify steps
- `docs/prototypes/walkthrough-ux-v2.html` — agreed viewer UX (ST6a); open in a browser, port to React

## Secrets

- `.env` (gitignored) holds `BOB_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`. Load them in the server only; never send them to the browser, log them, or commit them. `.env.example` documents the names.
