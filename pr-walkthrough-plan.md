# PR Walkthrough — Implementation Plan

> **Solo developer. Order: scaffold → viewer → polish → server logic → Bob Shell → demo.**
> Get visual feedback on the product before writing any server code.
> Session A (server chain) and Session B (viewer polish) run in parallel after ST1+ST2.
> **Each completed subtask (ST) must be committed to git before starting the next one.**
> ⚠️ As of Sep 26 the repo has **no commits** (ST1–ST4 are done but uncommitted). Commit before continuing.

## Top-Level Overview

**Goal:** Build an interactive PR walkthrough tool for the IBM Bob 2.0 Hackathon (Sep 25–27, 2026). Given a GitHub PR URL, the system analyses the full repository with Bob Shell (non-interactive) and produces a structured JSON walkthrough that a React viewer renders as an ordered, narrated, annotated route through the reviewer's reasoning.

**Scope:** Must-have items 1–6 from the brief. GitHub webhook and LLM fallback are "should" items addressed if time permits.

**Approach:**
- Monorepo with three packages: `shared` (schema + validators), `server` (Node/TS backend), `web` (React viewer).
- Bob Shell is the primary analyzer; a `CachedAnalyzer` enables zero-cost demo playback from pre-generated JSON.
- The viewer is a direct React port of the working prototype HTML.
- All Bob 2.0 agentic features (Plan mode, Agent mode, subagents, parallel tasks, custom skills, AGENTS.md) are used and documented throughout.

**Non-goals (this hackathon):** Auth, multi-tenant, databases, private repos, non-GitHub hosts, pre-generated audio files.

---

## Architecture

### Repo Layout

```
ai-review-walkthrough-2026/
  packages/
    shared/           TypeScript types (walkthrough schema), Zod validators, hunk-id helpers
    server/           Node.js + Express backend
    web/              React viewer (Vite)
  data/walkthroughs/  Pre-generated demo JSON (gitignored large files)
  bob_sessions/       Required hackathon screenshots
  docs/               Brief, schema, examples, prototype
  AGENTS.md           Bob Shell workspace instructions
  README.md
```

### Key Server Modules

| Module | Responsibility |
|---|---|
| `github/adapter` | Webhook handler + `POST /api/analyze` manual trigger; GitHub REST calls |
| `git/workspace` | Clone/fetch, checkout head/base, read-only enforcement |
| `git/diff-parser` | Parse `git diff` output into `Hunk[]` with stable ids |
| `analyzer/interface` | `Analyzer` interface; factory selecting bob/llm/cached via `ANALYZER` env var |
| `analyzer/bob-shell` | Spawn Bob Shell non-interactively, inject prompt+schema, capture JSON |
| `analyzer/llm` | Fallback: pre-collect context, call Claude/watsonx.ai |
| `analyzer/cached` | Read JSON from `data/walkthroughs/` |
| `validation/schema` | Zod parse of `Walkthrough` |
| `validation/verbatim` | Line-by-line check of quoted code against base/head files |
| `validation/coverage` | Compute `Coverage` from hunks + steps + skippedHunks |
| `storage` | Read/write JSON files on disk |
| `api` | Express routes: `GET /api/walkthroughs/:owner/:repo/:number` |

### Module Interfaces (TypeScript signatures)

```ts
// packages/shared/src/schema.ts  — re-exports walkthrough.ts types + Zod schema
export { Walkthrough, Step, Beat, Hunk, /* ... */ } from "./walkthrough.js";
export const WalkthroughSchema: z.ZodType<Walkthrough>;

// packages/shared/src/hunk-ids.ts
export function parseHunks(diffText: string): Hunk[];
export function hunkId(file: string, index: number): string; // "file#n"

// packages/server/src/analyzer/interface.ts
export interface AnalyzerInput {
  repoPath: string;
  baseSha: string;
  headSha: string;
  pr: PullRequestMeta;
  hunks: Hunk[];
  diff: string;
}
export interface Analyzer {
  analyze(input: AnalyzerInput): Promise<WalkthroughDraft>;
}
// WalkthroughDraft = Omit<Walkthrough, "hunks" | "coverage">

// packages/server/src/validation/index.ts
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  walkthrough?: Walkthrough; // with coverage populated
}
export function validate(draft: WalkthroughDraft, input: AnalyzerInput): ValidationResult;

// packages/server/src/git/workspace.ts
export interface RepoWorkspace {
  repoPath: string;
  baseSha: string;
  headSha: string;
  readFile(path: string, revision: "base" | "head"): Promise<string>;
  diff(): Promise<string>;
}
export function prepareWorkspace(repoUrl: string, pr: PullRequestMeta): Promise<RepoWorkspace>;
```

### Data Flow

```
GitHub webhook / POST /api/analyze
        │
        ▼
  github/adapter  ──► fetch PR metadata, commit list, linked issues
        │
        ▼
  git/workspace   ──► clone/fetch repo, checkout head, keep base sha
        │
        ▼
  git/diff-parser ──► produce Hunk[] with stable ids
        │
        ▼
  Analyzer (bob-shell | llm | cached)
        │   ┌─ inject: prompt template + schema + golden example
        │   └─ Bob Shell reads repo read-only, returns JSON
        ▼
  validation/schema ──► Zod parse
  validation/verbatim ──► line-by-line check against base/head
  validation/coverage ──► compute Coverage object
        │  (one repair retry on failure: send errors back to analyzer)
        ▼
  storage ──► write data/walkthroughs/{owner}/{repo}/{number}.json
        │
        ▼
  GET /api/walkthroughs/:owner/:repo/:number
        │
        ▼
  React viewer (web package)
```

---

## Sub-Tasks

---

### Sub-Task 1 — Monorepo scaffold + shared schema package

**Status:** [x] done

**Intent:** Bootstrap the project structure and publish the shared schema so all other packages can depend on it from day one. This avoids type drift between server and web.

**Expected Outcomes:**
- `packages/shared` compiles with `tsc`; exports `Walkthrough` types and `WalkthroughSchema` (Zod).
- `packages/server` and `packages/web` are scaffolded (empty `src/index.ts`, correct `tsconfig`, correct package deps).
- Root `package.json` with workspaces and scripts: `build`, `dev`, `lint`.
- `AGENTS.md` written at the workspace root describing read-only repo access rules for Bob Shell.

**✓ Verify (run these before marking done):**
```bash
pnpm install                              # no errors
pnpm --filter @pr-walkthrough/shared build  # tsc exits 0
node -e "const s = require('./packages/shared/dist/index.js'); console.log(typeof s.WalkthroughSchema)"
# prints: object
```

**Todo List:**
1. Init root `package.json` (pnpm workspaces: `packages/*`).
2. Create `packages/shared`: copy `docs/walkthrough.ts` to `src/walkthrough.ts`, add `src/hunk-ids.ts` (stub), add `src/schema.ts` (Zod schema derived from the TS types), export from `src/index.ts`.
3. Add `zod` dependency to `shared`; compile with `tsc`.
4. Create `packages/server`: Express + TypeScript scaffold, reference `@pr-walkthrough/shared`.
5. Create `packages/web`: Vite + React + TypeScript scaffold, reference `@pr-walkthrough/shared`.
6. Write `AGENTS.md` at root: workspace layout, read-only access convention for Bob Shell analyzer, how to run the server in dev.
7. Write root `README.md` skeleton.

**Relevant Context:**
- [`docs/walkthrough.ts`](docs/walkthrough.ts) — the authoritative schema to copy.
- The Zod schema must faithfully mirror every field, discriminated unions on `StepKind` / `SourceTag`, and optional fields.

---

### Sub-Task 2 — React viewer (static, golden JSON from disk)

**Status:** [x] done

**Intent:** Build the complete viewer UI before any server code exists. Load the golden JSON directly from disk so you can see — and critique — the actual product immediately after scaffolding. Every layout, colour, and UX decision made here costs nothing to change.

**Expected Outcomes:**
- Vite dev server starts at `http://localhost:5173`.
- Passing `?local=/path/to/outline-13673.walkthrough.json` loads the golden JSON without a server.
- All viewer components render correctly against the golden JSON: 11-step route rail, 1 dead-end struck-through, graph with 6 nodes that updates per step, beats with code blocks and annotations, value traces, narration, TTS play button, coverage panel (9 explained / 4 skipped of 13 hunks), questions panel (2 questions).
- Light and dark mode both work (CSS variables matching the prototype palette).
- No console errors.

**✓ Verify (manual, zero cost — this is your review checkpoint):**
1. `pnpm --filter @pr-walkthrough/web dev`
2. Open `http://localhost:5173/?local=../../docs/bob-brief/examples/outline-13673.walkthrough.json`
3. Confirm against prototype ([`docs/bob-brief/prototypes/walkthrough-viewer.html`](docs/bob-brief/prototypes/walkthrough-viewer.html)) — open both side by side.
4. Check every item in Expected Outcomes above.
5. **You decide here:** is the layout and product feel right? Note any changes before moving to server work.

**Golden JSON complexity baseline:**
- 11 steps | 1 dead-end (`s9`) | 6 graph nodes | 6 edges with `visibleFrom`/`visibleUntil`
- 13 hunks (9 explained + 4 skipped) | 17 beats | 4 beats with traces | 2 open questions
- focusNode hops: cn → cn → header → rv → ctx → diff → rv → ctx → rv → cn → cn

**Component Tree:**
```
App
├── TopBar  (PR metadata, stats, summary)
├── Layout
│   ├── RouteRail  (step list, active indicator, dead-end strikethrough on isDeadEnd steps)
│   └── MainPanel
│       ├── GraphView  (SVG, dagre, 6 nodes, 6 edges; visibleFrom/visibleUntil per edge; hop arrow between consecutive focusNodes)
│       ├── StepView
│       │   ├── StepHeader  (title, kind label, source-tag chip)
│       │   ├── NarrationBlock  (IBM Plex Serif text + speak button)
│       │   ├── Beat[]  (1-2 per step: current | problem | change)
│       │   │   ├── CodeBlock[]  (revision base|diff|head; dashed border when reconstructed)
│       │   │   │   └── CodeLine[]  (context|focus|added|removed|elided)
│       │   │   │       └── Annotation?  (annotationTag chip, shown as ↳ below the line)
│       │   │   └── Traces?  (value trace rows: label chips with ok/bad/neutral colours)
│       │   ├── Notes?  (muted footnote text)
│       │   └── Sources  (small ref list at step bottom)
│       └── StepNav  (Prev / Next buttons, keyboard arrow listener)
├── QuestionsPanel  (open questions, each with tag chip and why text)
└── CoveragePanel  (hunk table: explained count, skipped list, uncovered warning)
```

**Todo List:**
1. Scaffold Vite + React + TypeScript in `packages/web`; use plain CSS variables matching the prototype palette (IBM Plex fonts, exact colour tokens from the prototype).
2. Implement `useWalkthrough` hook: accept a `?local=` path param to load JSON from disk via `fetch`; skip server for now.
3. Implement `RouteRail` — step list, active highlight, `isDeadEnd` strikethrough.
4. Implement `GraphView` — dagre layout, SVG nodes + edges, `visibleFrom`/`visibleUntil` filtering per step, dashed hop arrow between consecutive `focusNode` values.
5. Implement `StepView` — `StepHeader`, `NarrationBlock`, `Beat`, `CodeBlock`, `CodeLine`, `Annotation`, `Traces`, `Notes`, `Sources`.
6. Implement `StepNav` + keyboard arrow listener.
7. Implement `QuestionsPanel` and `CoveragePanel`.
8. Integrate Web Speech API — speak on demand; "Play all" auto-advances steps.
9. Wire up `TopBar` with PR metadata and summary.

**Relevant Context:**
- The prototype ([`docs/bob-brief/prototypes/walkthrough-viewer.html`](docs/bob-brief/prototypes/walkthrough-viewer.html)) is the definitive visual reference — port it faithfully, do not invent a new design.
- Code line `kind` → style: `added` = green bg, `removed` = red bg + strikethrough text, `focus` = yellow bg, `elided` = muted italic.
- The `?local=` param is a dev convenience; in production the hook will fetch from `GET /api/walkthroughs/:owner/:repo/:number`.

---

### Sub-Task 3 — Git workspace + diff parser

**Status:** [x] done

**Intent:** Give the server reliable, repeatable access to base and head file contents and a parsed `Hunk[]` list. This is the foundation for both the analyzer input and the verbatim validator.

**Expected Outcomes:**
- `prepareWorkspace(repoUrl, pr)` clones (or fetches) the repo, checks out head, returns a `RepoWorkspace` with `readFile(path, "base"|"head")` and `diff()`.
- `parseHunks(diffText)` returns `Hunk[]` with stable `file#n` ids matching the schema.
- Unit tests for `parseHunks` covering multi-file diffs, renames, and binary files.

**✓ Verify (run these before marking done):**
```bash
pnpm --filter @pr-walkthrough/server test          # all Vitest tests pass
# expected: "13 hunks parsed" matching golden example ids
# e.g.: app/components/DocumentContext.tsx#1, #2 ...
```

**Todo List:**
1. Implement `packages/server/src/git/workspace.ts`: use `simple-git` or `child_process` git commands; cache clones under a configurable `GIT_CACHE_DIR`.
2. Implement `readFile(path, revision)`: for `"base"` use `git show {baseSha}:{path}`; for `"head"` read the checked-out file.
3. Implement `packages/shared/src/hunk-ids.ts`: parse unified diff with a regex state machine; assign `file#1`, `file#2` ids.
4. Write unit tests (Vitest) for the parser against the diff of `outline/outline#13673`.

**Relevant Context:**
- The golden example ([`docs/bob-brief/examples/outline-13673.walkthrough.json`](docs/bob-brief/examples/outline-13673.walkthrough.json)) lists 13 hunk ids; the parser output must match these ids exactly.
- `git show {sha}:{path}` is the safest way to read base-revision files without switching branches.

---

### Sub-Task 4 — Validation pipeline (schema + verbatim + coverage)

**Status:** [x] done

**Intent:** Enforce the correctness guarantees that make the product trustworthy: schema validity, no hallucinated code lines, every diff hunk accounted for.

**Expected Outcomes:**
- `validate(draft, input)` returns `{ valid, errors[], walkthrough? }`.
- Schema errors surface field paths (Zod `.format()`).
- Verbatim check: for each `CodeBlock` that is not `reconstructed`, every non-`elided` line's `.text` must exist verbatim in the correct revision file. Whitespace is compared after normalising CRLF→LF; leading/trailing whitespace is compared literally (indentation matters).
- Coverage object is populated: `totalHunks`, `explained`, `skipped`, `uncoveredHunkIds`.
- One repair retry: if validation fails, re-invoke the analyzer with the error list appended to the prompt.

**✓ Verify (run these before marking done):**
```bash
pnpm --filter @pr-walkthrough/server test          # all Vitest tests pass
# key assertions:
#   validate(goldenJson, input).valid === true
#   coverage.explained === 9, coverage.skipped === 4, coverage.uncoveredHunkIds === []
#   a deliberately mutated code line → valid === false with a clear error message
```

**Todo List:**
1. Implement `packages/server/src/validation/schema.ts`: Zod parse, format errors.
2. Implement `packages/server/src/validation/verbatim.ts`: for each `Step → Beat → CodeBlock`, call `workspace.readFile(block.file, block.revision)`, split into lines, check each non-elided line is present (substring or exact-line match — use exact-line).
3. Implement `packages/server/src/validation/coverage.ts`: collect all `hunkIds` from all steps + `skippedHunks.hunkId`; diff against `input.hunks`; build `Coverage`.
4. Wire into `packages/server/src/validation/index.ts`.
5. Write tests using the golden JSON + the actual files from `outline/outline` at the recorded SHAs.

**Relevant Context:**
- Brief §5.9: "74 of 74 quoted lines matched the real files" — verbatim check is load-bearing.
- Brief §5.8: coverage computation belongs in the backend, not the analyzer.
- The repair retry must pass validation errors as a structured list, not free prose, so the analyzer can fix specific fields.

---

### Sub-Task 5 — Analyzer interface + CachedAnalyzer + Bob Shell analyzer

**Status:** [-] in progress

**Intent:** Build the analyzer abstraction with two concrete implementations: `CachedAnalyzer` for zero-cost demo playback, and `BobShellAnalyzer` for live generation. Invocation design is in "Bob Shell Analyzer Design"; the working prototype is `packages/server/scripts/bob-spike.ts` — port it, do not re-invent it.

**Expected Outcomes:**
- `CachedAnalyzer` reads JSON from `data/walkthroughs/` and returns it without calling Bob.
- `BobShellAnalyzer` pipes the filled prompt to `bob run --format json --mode pr-walkthrough …` (see design section) and extracts the walkthrough from the JSON envelope.
- Read-only is enforced by the `pr-walkthrough` custom mode (`groups: [read]`) — NOT by default: `bob run` pre-approves every tool of the active mode, and the default `agent` mode can edit files and run shell.
- Backend overwrites `draft.pr` with the real `PullRequestMeta` before validation (the analyzer is told to omit it; the Zod schema requires it).
- Analyzer selected via `ANALYZER=cached|bob|llm` env var.
- Process-level 10-minute timeout; elapsed time and analyzer type logged per run.

**✓ Verify (run these before marking done — CachedAnalyzer only, no Bobcoins spent):**
```bash
# copy golden JSON into cache location first:
mkdir -p data/walkthroughs/outline/outline
cp docs/bob-brief/examples/outline-13673.walkthrough.json data/walkthroughs/outline/outline/13673.json

ANALYZER=cached pnpm --filter @pr-walkthrough/server dev &
curl -s http://localhost:3000/api/walkthroughs/outline/outline/13673 | node -e \
  "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); console.log(j.steps.length)"
# prints: 11
```
> Do NOT run BobShellAnalyzer during verification — that costs Bobcoins. Only test CachedAnalyzer here.

**Todo List:**
1. Define `Analyzer` interface and `AnalyzerInput` / `WalkthroughDraft` types in `packages/server/src/analyzer/interface.ts`.
2. Implement `CachedAnalyzer` in `cached.ts`: reads `data/walkthroughs/{owner}/{repo}/{number}.json`.
3. Implement `BobShellAnalyzer` in `bob-shell.ts` by porting `scripts/bob-spike.ts`: write `.walkthrough/` sidecar + `.bob/custom_modes.yaml` into the checkout, fill the prompt (`walkthrough.ts` text + golden JSON without `hunks`/`coverage`/`pr`), spawn `bob run` with `--max-cost`, 10-min timeout, extract the walkthrough from the `--format json` envelope with a balanced-brace JSON extractor (not a greedy regex).
4. Add `ANALYZER` env-var factory in `analyzer/index.ts`.
5. Keep `AGENTS.md` in sync with the invocation (mode, flags, sidecar layout).
6. Log: start time, duration, analyzer type.

**Relevant Context:**
- Bob Shell invocation: see "Bob Shell Analyzer Design" below.
- Envelope (confirmed by ST5a): `{ type, timestamp, status, stats: { task_id, duration_ms, session_costs, max_cost, tool_calls }, last_message }`. The walkthrough is inside `last_message`, usually wrapped in a ```json fence after a line of prose.
- Port `normalizeDraft()` too: Bob sometimes cites `.walkthrough/base/<path>` as a code block's `file`. Backend sets `meta.generatedAt`/`durationMs` (Bob invents them).
- Prompt template: [`docs/analyzer-prompt.md`](docs/analyzer-prompt.md); inject full `walkthrough.ts` and golden JSON at fill time.
- Subagents: instruct Bob Shell in the prompt to spawn subagents for independent symbol searches (e.g. "spawn a subagent to find all usages of this function").

---

### Sub-Task 5a — Bob Shell spike on #10295 (run by the user, needs Bobcoins)

**Status:** [x] done (Sep 26) — smoke, readonly and full runs passed; see `docs/cost-log.md`

**Results:** key works headless; custom mode picked up and blocks writes; full run on #10295 = 174 s, $3.13 (`session_costs` is USD), 43 tool calls, 10 steps, 5/5 hunks, valid after path normalisation. Output stored at `data/walkthroughs/excalidraw/excalidraw/10295.json` — use it as real test data for UI and backend work.

**Intent:** Answer the open questions about Bob Shell with real runs before building on them. Five numbers decide the rest: time, Bobcoins before/after, did the JSON parse, what the validator said, and did read-only hold.

**Run (from repo root, `BOB_API_KEY` exported; `prepare` is free):**
```bash
pnpm --filter @pr-walkthrough/server spike prepare    # checkout + sidecar + prompt, no Bob call
pnpm --filter @pr-walkthrough/server spike smoke      # key works? envelope shape? cost of a trivial call
pnpm --filter @pr-walkthrough/server spike readonly   # asks Bob to write a file → summary.readOnlyHeld must be true
MAX_COST=5 pnpm --filter @pr-walkthrough/server spike full   # real analysis + validation
```
Every run writes `data/runs/<stamp>-<mode>/` (prompt, raw stdout/stderr, summary, draft/validated JSON).

**Questions this answers:**
1. Does `BOB_API_KEY` (Inference scope) work headless with `--trust --accept-license`?
2. Shape of `bob run --format json` output — where the final text and the cost live.
3. Is the project-level `.bob/custom_modes.yaml` in the checkout picked up with `--workspace`? Is group `read` alone enough, or is `subagent` also needed/allowed?
4. Does the `pr-walkthrough` mode block writes (readonly run)?
5. Cost and duration of one full run; does `--max-cost` actually stop it?

**Done when:** numbers recorded in `docs/cost-log.md`, and the design section below updated with the answers.

---

### Sub-Task 6 — GitHub adapter + job orchestration

**Status:** [ ] pending

**Intent:** Connect the pipeline to GitHub: accept a manual trigger via HTTP, fetch PR metadata, and optionally handle webhooks.

**Expected Outcomes:**
- `POST /api/analyze { prUrl }` triggers the full pipeline and returns `{ walkthroughUrl }`.
- GitHub metadata fetcher: PR title, body, commits, linked issues, files changed, base/head SHAs.
- Webhook handler for `pull_request` events (opened/synchronize) — can be registered behind a feature flag and tested with smee.io.
- Optional: post a PR comment with the walkthrough link once generation succeeds.

**✓ Verify (run these before marking done — uses ANALYZER=cached, no Bobcoins):**
```bash
ANALYZER=cached pnpm --filter @pr-walkthrough/server dev &
# trigger with the pre-cached PR (no Bob Shell call, no Bobcoins):
curl -s -X POST http://localhost:3000/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"prUrl":"https://github.com/outline/outline/pull/13673"}' \
  | node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(j.walkthroughUrl)"
# prints a URL like: http://localhost:3000/api/walkthroughs/outline/outline/13673
curl -s http://localhost:3000/api/walkthroughs/outline/outline/13673 | node -e \
  "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(j.coverage.explained)"
# prints: 9
```

**Todo List:**
0. Fix `prepareWorkspace`: fork PR heads are not on any upstream branch — fetch `pull/{number}/head` (and the base sha) explicitly before checkout; clone with `--filter=blob:none` to keep large repos fast (see `scripts/bob-spike.ts`).
1. Implement `packages/server/src/github/client.ts`: wrap Octokit; read `GITHUB_TOKEN` from env; fetch PR metadata and commit list.
2. Implement `packages/server/src/github/adapter.ts`: `analyzePR(prUrl)` orchestrates workspace prep → diff parse → analyzer → validation → storage.
3. Add Express routes in `packages/server/src/api/routes.ts`: `POST /api/analyze`, `GET /api/walkthroughs/:owner/:repo/:number`.
4. Implement webhook handler: verify GitHub signature (`X-Hub-Signature-256`), enqueue job (simple in-memory queue for the hackathon).
5. Optional: `postPRComment(pr, walkthroughUrl)` via Octokit.

**Relevant Context:**
- Without a `GITHUB_TOKEN`, the GitHub API rate-limits at 60 req/h — too low for cloning private PRs or heavy polling.
- The `GET /api/walkthroughs/...` response is the single endpoint the React viewer fetches.

---

### Sub-Task 7 — Demo data generation and caching

**Status:** [ ] pending

**Intent:** Pre-generate walkthrough JSON for the three demo PRs using Bob Shell (or manually), store them in `data/walkthroughs/`, and configure the server's `CachedAnalyzer` to serve them. This decouples the demo from live API calls and Bobcoin budget.

**Expected Outcomes:**
- `data/walkthroughs/outline/outline/13673.json` present and valid (the golden example, cleaned up to match final schema).
- At least one Excalidraw PR walkthrough generated and stored.
- `ANALYZER=cached` mode serves these files end-to-end through the viewer with no errors.
- Bobcoin usage logged per generation run.

**⚠️ Budget gate — do this before spending any Bobcoins on ST7:**
```bash
# 1. Validate the adapted golden JSON with zero cost first:
node -e "
  const { WalkthroughSchema } = require('./packages/shared/dist/index.js');
  const json = require('./data/walkthroughs/outline/outline/13673.json');
  const result = WalkthroughSchema.safeParse(json);
  console.log(result.success ? 'VALID' : result.error.format());
"
# Must print: VALID before proceeding to Bob Shell generation.

# 2. Generate #10295 first (smallest PR, lowest cost). Record Bobcoins before and after.
# 3. Validate output immediately — if invalid, fix the prompt before generating #10013.
# 4. Only generate #10013 if budget > 15 Bobcoins remaining.
```

**✓ Verify end-to-end (after caching, zero additional cost):**
```bash
ANALYZER=cached pnpm dev   # starts both server and web
# open http://localhost:5173/excalidraw/excalidraw/10295
# check: walkthrough loads, all steps render, narration plays
```

**Todo List:**
1. Adapt the golden JSON (`docs/bob-brief/examples/outline-13673.walkthrough.json`) to the final schema (fill any gaps, run validation).
2. **Check Bobcoin balance.** Generate walkthrough for `excalidraw/excalidraw#10295` using Bob Shell (smallest PR — lowest cost), always with `--max-cost`. Validate immediately. (If ST5a's `full` run was valid, its `walkthrough.json` is this file.)
3. **Check Bobcoin balance again.** Only generate `excalidraw/excalidraw#10013` if balance > 15 coins.
4. Document Bobcoin cost per run in `docs/cost-log.md`.
5. Verify `ANALYZER=cached` serves all stored walkthroughs correctly through the full stack.

**Relevant Context:**
- Brief §11: develop the analyzer prompt on `#10295` first (5 files, +19 −7).
- Excalidraw is MIT licensed — safe to use. Verify Outline licence before including in the demo.
- Start Bob Shell with `ANALYZER=bob` for live generation; use `ANALYZER=cached` for all demo runs.

---

### Sub-Task 8 — Bob 2.0 features showcase + bob_sessions screenshots

**Status:** [ ] pending

**Intent:** Ensure the judges can see Bob 2.0 features in action. This is an eligibility requirement, not optional polish.

**Expected Outcomes:**
- `bob_sessions/` folder contains at least one PNG per significant task, named `teamname_taskNN_short_description.png`.
- `README.md` has a "How we used Bob 2.0" section listing each feature and where it was applied.

**Bob 2.0 Features and Where They Appear:**

| Feature | Where used |
|---|---|
| Plan mode | This plan file; initial architecture design |
| Agent mode | Implementing each sub-task sequentially |
| Subagents | Inside BobShellAnalyzer prompt: Bob Shell spawns subagents for parallel symbol searches ("where is this value read?") |
| Parallel tasks | Subagents inside a single Bob Shell analysis run to explore independent code paths concurrently |
| Custom skill | `/walkthrough <PR url>` skill for interactive use in the IDE (Could item #12 from brief) |
| AGENTS.md | Workspace instructions for Bob Shell read-only access, repo layout, dev commands |
| Bob Shell | `BobShellAnalyzer` — core analyzer; runs non-interactively in the repo checkout |
| Rollback | Used if a sub-task implementation breaks existing tests |
| Document understanding | Bob reads the golden JSON and walkthrough.ts schema during planning and analyzer prompt injection |

**Todo List:**
1. Take PNG screenshots of each Bob session as work progresses.
2. Name files `{teamname}_task{nn}_{short_description}.png` and commit to `bob_sessions/`.
3. Write the "How we used Bob 2.0" section in `README.md`.

---

### Sub-Task 9 — README, demo video, final polish

**Status:** [ ] pending

**Intent:** Produce the submission artefacts: README, demo video, and any final fixes caught during end-to-end testing.

**Expected Outcomes:**
- `README.md` covers: problem statement, product overview, quick-start (clone + `pnpm install` + `pnpm dev`), env vars, demo mode instructions, Bob 2.0 features used, team, licence.
- A short demo video (screen recording) showing the viewer with narration for the golden PR.
- End-to-end smoke test: `pnpm dev` starts server + web; opening `http://localhost:5173/outline/outline/13673` renders the full walkthrough.

**Todo List:**
1. Complete `README.md`.
2. Record demo video (screen capture of the viewer + narration playing for the outline PR).
3. Run end-to-end smoke test.
4. Fix any final issues.
5. Verify `bob_sessions/` is committed.
6. Submit before Sep 27, 15:00 UTC.

---

### Sub-Task 10 — Analyzer quality iteration (LAST, after ST6–ST9 work end-to-end)

**Status:** [ ] pending — deliberately deferred: build UI + backend on the current valid output first.

**Intent:** Structure of Bob's output is already right; the gap is depth of the causal explanation. Iterate the prompt only once the product works end-to-end.

**Known gap (from ST5a on #10295):** the PR's key mechanism lives outside the diff — `Sidebar.tsx` closes the floating sidebar via its own `useOutsideClick` → `closeLibrary()`, and the hook skips targets with `[data-prevent-outside-click]`. Removing that attribute from the menu trigger IS the fix; the `.dropdown-menu-container` wrapper only stops the menu from closing itself. Bob's s8 called the removal "redundant" (tagged `fact`), s5 narration misplaces the close logic, and `Sidebar.tsx` is never quoted. Open question 1 (inner `.dropdown-menu-container`) is a false alarm — those elements are below `menuRef`, not ancestors.

**Prompt changes to try:**
1. For every behaviour the PR title/description claims, find and quote the code that produces it; if no hunk does, it is outside the diff — locate it.
2. For removed code (attributes, guards, handlers), find who relied on it and what now fires differently.

**Acceptance checklist for #10295 (quality metric):** a step quotes `Sidebar.tsx` `useOutsideClick` → `closeLibrary()`; attribute removal is presented as the decision, not cleanup; no factual error in narration. Budget: ≤ 2 re-runs (~$3 each), then #10013.

---

## Resolved Questions

| Question | Answer |
|---|---|
| Bob Shell non-interactive invocation | Flags verified against `bob run --help` (v2.0.5); runtime behaviour pending ST5a spike |
| Solo or team? | Solo developer, sequential tasks |
| Outline licence | Unverified — exclude from public demo; use as private test data only |
| LLM fallback if Bobcoins run out | Claude API (credentials to be configured) |
| Narration language | English only |
| Before/after video for #10295 | Deprioritised — attempt only after all Must items complete |

---

## Bob Shell Analyzer Design

Verified against Bob Shell 2.0.5 (`bob run --help`, the bundled mode definitions, and
bob.ibm.com/docs/shell). Items marked **(spike)** are confirmed only by ST5a.

**Facts that shaped the design:**
- Headless command is `bob run [options] [prompt...]`; the prompt can come from stdin.
  The earlier draft's `--hide-intermediary-output` and `--allowed-tools` flags **do not exist**.
- `bob run` **pre-approves every tool** of the active mode. The default mode `agent`
  has `read, edit, execute, browser, mcp, todo, subagent, mode` — so "read-only by
  default" is false. Built-in `ask` is read-only but has no shell and a
  "questions about Bob the product" role; `plan` may write `.md`/`.txt`.
- Useful limits exist: `--max-cost <bobcoins>`, `--max-turns <n>`, `--disable-mcp`,
  `--disable-subagents`, `--disable-tool-groups <g,...>`, `--workspace <path>`.
- Auth: `BOB_API_KEY` env var with an **Inference**-scoped key (a General key also
  needs `--team-id`). First run needs `--trust --accept-license`.

**Design:**
1. Read-only via a custom mode written into the checkout as
   `.bob/custom_modes.yaml`: slug `pr-walkthrough`, `groups: [read]`, reviewer role.
   No shell, no edit. **(spike: project-level mode picked up with `--workspace`)**
2. No shell means no `git`, so the backend writes a sidecar into the checkout:
   `.walkthrough/base/<path>` (changed files at BASE), `.walkthrough/pr.diff`,
   `.walkthrough/commits.txt`. Both `.walkthrough/` and `.bob/` go into
   `.git/info/exclude`. The prompt (`docs/analyzer-prompt.md`) describes this layout.
3. Invocation:
   ```ts
   spawn("bob", [
     "run", "--format", "json", "--mode", "pr-walkthrough",
     "--workspace", repoPath, "--max-cost", MAX_COST, "--max-turns", "40",
     "--disable-mcp", "--trust", "--accept-license",
   ], { cwd: repoPath, timeout: 600_000 });   // prompt written to stdin
   ```
4. Output: `--format json` prints one JSON object after the session. Its exact shape is
   undocumented **(spike)**; the extractor walks the envelope, finds the string that
   contains the walkthrough and parses the first balanced `{…}` object in it.
5. Backend sets `pr` (and later `hunks`, `coverage`), then runs `validate()`. On
   failure: one repair run with the structured error list appended (ST5, budget-gated).
6. Subagents: kept enabled only if the spike shows the `read`-only mode can still spawn
   the `explore` subagent; otherwise pass `--disable-subagents` and drop the claim
   from the "Bob features" table.

Reference implementation: `packages/server/scripts/bob-spike.ts`.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bob Shell wraps / mixes the JSON with prose | Medium | Balanced-brace extractor over the `--format json` envelope; raw output saved in `data/runs/` |
| A run burns more Bobcoins than expected | Medium | Always pass `--max-cost`; `smoke` spike measures the floor cost first |
| Custom mode not picked up → Bob runs in `agent` mode with edit + shell pre-approved | Medium | `readonly` spike run; checkout lives in a throwaway cache dir, never in this repo |
| Bob Shell produces invalid JSON or hallucinates code lines | Medium | Validation + one repair retry; golden example in prompt as few-shot reference |
| Bobcoin budget runs out before demo PRs are generated | Medium | Generate `#10295` first (5 files, +19−7); CachedAnalyzer for demo runs; Claude API fallback |
| `outline/outline` licence unverified | Confirmed risk | Exclude from public demo; use only Excalidraw PRs (MIT); outline is private test data |
| Excalidraw doesn't build at old commits for video | Medium | Attempt only after Must items complete; manual screen recording acceptable per brief §10 |
| dagre graph layout looks bad for some PRs | Low | Test with golden JSON early; fall back to manual layout hints grid |
| Solo dev misses `bob_sessions` screenshots | Medium | Take screenshot immediately after each sub-task completes; never batch at end |

---

## Execution Order

### Phase 1 — See it first (zero server code, zero Bobcoins)

```
ST1  Monorepo scaffold + shared schema        (unblocks everything)
     │
     ▼
ST2  React viewer (static, loads golden JSON from disk)
     │
     ▼
     ← YOU REVIEW THE VIEWER HERE →
     Polish layout, colours, component details against the prototype.
     Adjust the plan if anything looks wrong or missing.
     Only proceed once you're happy with what the product looks like.
```

**Why this order:** the viewer only needs ST1's shared types and the golden JSON that already exists in the repo. You get a working product UI in front of you with zero server work and zero Bobcoins. Any layout or UX decisions you make here are free — once the server is built, changes are harder.

### Phase 2 — Two parallel sessions (after you approve the viewer)

```
ST1  ✓ done
ST2  ✓ done (viewer)
          │
          ├────────────────────────────────────────────────────────────┐
          │                                                            │
          ▼  Bob Session A — server chain (packages/server)           ▼  Bob Session B — viewer polish
          ST3  Git workspace + diff parser                             Continue refining the viewer
          ST4  Validation pipeline                                     based on what you see running
          ST5  Analyzer interface + CachedAnalyzer + BobShellAnalyzer
          ST6  GitHub adapter + API routes
          │                                                            │
          └────────────────────────────┬───────────────────────────────┘
                                       │
                                       ▼
                                     ST7  Demo data generation + caching
                                     ST8  Screenshots + README  (take screenshots after each sub-task)
                                     ST9  Final polish + demo video + submit
```

**Within Session A, ST3 → ST4 → ST5 → ST6 must stay sequential:** each step's output feeds the next.

**No file conflicts:** `packages/server/` and `packages/web/` share only the read-only types from `packages/shared/` (written in ST1).

---

## Milestones

| # | Milestone | Bobcoin cost |
|---|---|---|
| M1 | Monorepo + shared schema compiles; golden JSON validates against Zod schema | 0 |
| M2 | **Viewer renders golden PR in browser** — route rail, graph, beats, narration, coverage | 0 |
| M2.5 | ← **You review and approve the viewer appearance** | 0 |
| M3 | Git workspace + diff parser produces correct Hunk[] | 0 |
| M4 | Validation pipeline passes on golden JSON + real files | 0 |
| M5 | CachedAnalyzer + API routes serve golden JSON end-to-end | 0 |
| M6 | Viewer fetches from server API; full stack works with cached JSON | 0 |
| M6.5 | ST5a spike: smoke + readonly + full run on `#10295`, numbers in `docs/cost-log.md` | ~2–8 Bobcoins |
| M7 | BobShellAnalyzer generates valid walkthrough for `#10295` | ~5–15 Bobcoins |
| M8 | All demo PRs cached; full stack demo working | ~10–30 Bobcoins total |
| M9 | Submission: bob_sessions, README, demo video, smoke test | 0 |
