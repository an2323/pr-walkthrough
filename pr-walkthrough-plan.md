# PR Walkthrough — Implementation Plan

> **Solo developer. Order: scaffold → viewer → polish → server logic → Bob Shell → demo.**
> Get visual feedback on the product before writing any server code.
> Session A (server chain) and Session B (viewer polish) run in parallel after ST1+ST2.
> **Each completed subtask (ST) must be committed to git before starting the next one.**

## Top-Level Overview

**Goal:** Build an interactive PR walkthrough tool for the IBM Bob 2.0 Hackathon (Sep 25–27, 2026). Given a GitHub PR URL, the system analyses the full repository with Bob Shell (non-interactive) and produces a structured JSON walkthrough that a React viewer renders as an ordered, narrated, annotated route through the reviewer's reasoning.

**Scope:** Must-have items 1–6 from the brief, plus ST6c (live analysis), ST6d (GitHub round-trip) and ST6f (public demo). **Cut on Sep 26:** LLM fallback analyzer (Claude/watsonx), live GitHub webhook (smee), Outline in the public demo. The agent-verifier (ST6e) was cut and then **brought back** the same day: it runs after the main items, before ST11.

**Approach:**
- Monorepo with three packages: `shared` (schema + validators), `server` (Node/TS backend), `web` (React viewer).
- Bob Shell is the primary analyzer; a `CachedAnalyzer` enables zero-cost demo playback from pre-generated JSON.
- The viewer is a direct React port of the working prototype HTML.
- All Bob 2.0 agentic features (Plan mode, Agent mode, subagents, parallel tasks, custom skills, AGENTS.md) are used and documented throughout.

**Non-goals (this hackathon):** Auth, multi-tenant, databases, private repos, non-GitHub hosts. (Pre-generated narration audio IS in scope now — see ST6b.)

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
export function prepareWorkspace(repoUrl: string, headSha: string, baseSha: string, cacheDir?: string): Promise<RepoWorkspace>; // as implemented
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
- `prepareWorkspace(repoUrl, headSha, baseSha, cacheDir?)` clones (or fetches) the repo, checks out head, returns a `RepoWorkspace` with `readFile(path, "base"|"head")` and `diff()`.
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

**Status:** [x] done

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
- Subagents: NOT in ST5. The `pr-walkthrough` mode has `groups: [read]` only and the ST5a run worked without subagents. Trying `subagent` in the mode is part of ST10.

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

**Status:** [x] done

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
3. Add Express routes in `packages/server/src/api/routes.ts`: `POST /api/analyze`, `GET /api/walkthroughs/:owner/:repo/:number`, and `GET /api/context/:owner/:repo/:number?file=&rev=base|head&from=&to=` (returns real file lines from the cached checkout, so the viewer can expand code context beyond what the analyzer quoted).
4. Implement webhook handler: verify GitHub signature (`X-Hub-Signature-256`), enqueue job (simple in-memory queue for the hackathon).
5. Optional: `postPRComment(pr, walkthroughUrl)` via Octokit.

**Relevant Context:**
- Without a `GITHUB_TOKEN`, the GitHub API rate-limits at 60 req/h — too low for cloning private PRs or heavy polling.
- The `GET /api/walkthroughs/...` response is the single endpoint the React viewer fetches.

---

### Sub-Task 6a — Viewer v2: low-cognitive-load UX

**Status:** [x] done

**Intent:** Replace the "everything on one screen" viewer with the agreed UX. Reference implementation (single HTML file, both demo PRs, open it in a browser): [`docs/prototypes/walkthrough-ux-v2.html`](docs/prototypes/walkthrough-ux-v2.html). Port its structure and behaviour to React; keep the current colour tokens (palette is a later step).

**Principles (do not regress):**
- One screen = one idea: plain-language headline, one sentence, ONE visual, one reviewer action. No identifiers in prose — identifiers live only inside code.
- Route = three chapters (Problem → Fix → Try it) shown as dots in the top bar; no left step list.
- Code shows changed lines ±3 context; the rest folds into "⋯ N more lines" that expands in place; "open file ↗" links to GitHub at the right sha. When a step has a visual AND code, the code is behind "Show the code change".
- The map (graph) appears ONLY on the start screen (Before/After toggle) and on steps whose visual is `map`. Edge labels in plain words, identifier in the tooltip. Only nodes touched by the shown edges. **Superseded by ST6g:** the map leaves the start screen and becomes on-demand (button on every screen + link in the summary).
- "How the analysis got here" opens a side drawer with the full analysis (beats, annotations, sources, notes, full question). This is where technical depth lives.
- Source marker only when not a fact: "from the commit history" / "our reading of the code" / "not run yet". Dead ends = "Detour" with a struck-through old path.
- Voice is one button in the bottom bar; the screen text stays short, narration is richer. "Listen instead" on the start screen plays the whole route.
- Minor steps and skipped hunks are not screens: they are one line each in the summary.
- The last two screens ("Try it in the app", "Your review") stay as in the prototype for now — the user wants to redesign them later.

**Schema additions (all optional, with fallbacks so current JSON still renders):**
```ts
// Walkthrough
plain?: { title: string; problem: string; fix: string };
// Step
headline?: string;          // ≤ 9 words, no identifiers   — fallback: routeLabel
say?: string;               // 1 sentence, no identifiers  — fallback: first sentence of narration
check?: string;             // one concrete thing for the reviewer to verify — fallback: none
minor?: boolean;            // shown only in the summary
visual?:
  | { type: "flow"; rows: { label: string; status?: "ok" | "bad" | "old" }[][] }  // fallback: beat traces
  | { type: "map"; caption?: string }
  | { type: "symptoms"; items: string[] };
// GraphEdge
plainLabel?: string;        // fallback: label
// OpenQuestion
short?: string;             // one-line plain version — fallback: question
```
The analyzer starts filling these in ST10; until then the viewer uses the fallbacks.

**✓ Verify (zero cost):** both `data/walkthroughs/excalidraw/excalidraw/10295.json` and the Outline golden JSON render without errors via the API; step through every screen with ← →; expand a fold; open "How the analysis got here"; toggle Before/After on the start screen; no horizontal scroll at 400 px width; `pnpm --filter @pr-walkthrough/web lint` passes.

---

### Sub-Task 6b — Narration audio (ElevenLabs, backend-only)

**Status:** [x] done

**Intent:** Replace robotic Web Speech with good narration for the demo, without exposing the key or depending on the network during the demo.

**Design:**
- `TtsProvider` interface (like `Analyzer`): `ElevenLabsTts` (primary) and `WebSpeech` fallback on the client when audio is unavailable.
- One audio file **per sentence** of `step.narration` (sentence split must match the viewer's) → captions stay in sync without timestamps.
- `GET /api/audio/:owner/:repo/:number/:stepId/:sentence.mp3` → serves `data/audio/{owner}/{repo}/{number}/{stepId}-{n}.mp3`; generates it on first request, then always from disk. Cache key includes a hash of the sentence text + voice id, so edited narration regenerates.
- Script `pnpm --filter @pr-walkthrough/server tts:pregen <owner/repo#number>` generates all files for a demo PR ahead of time.
- ElevenLabs call: `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=mp3_44100_128`, header `xi-api-key`, body `{ text, model_id: "eleven_multilingual_v2" }`. The voice is a Voice Library voice: `GET /v1/voices/{id}` returns 404 for it, but TTS works — do not treat the 404 as an error.
- Budget: Outline narration ≈ 3k characters; the key has a credit cap. Log characters per run.

**✓ Verify:** pregen for #10295 creates one mp3 per sentence; a second run makes 0 API calls; with `ELEVENLABS_API_KEY` unset the viewer falls back to Web Speech and nothing breaks.

---

> **ST6c–ST6f** were added on Sep 26 after ST5–ST6b were closed. ST5–ST6b stay closed as history;
> these are new work that continues the server + UI track before ST7. Order: **ST6c → ST6d → ST6f → ST7**.
> None of them spends Bobcoins except a real run on the ST6c progress screen, which goes through the
> stage-2 budget guard like any other run.

### Sub-Task 6c — Live analysis: job queue + progress screen

**Status:** [x] done (Sep 26) — built and verified with `ANALYZER=cached` and replays of the recorded #10295 / #8340 runs, $0. The live `ANALYZER=bob` path is wired but not yet exercised on a real run (needs the user's go-ahead to spend).

**As built:** `POST /api/analyze {prUrl, force?}` → 202 `{jobId}` (re-attaches to a running job for the same PR; in bob mode only one paid run at a time → 409; an already-cached PR is served without a new run unless `force: true`). `GET /api/jobs/:id` and `GET /api/jobs/:id/events` (SSE, backlog first). `GET /api/runs/:owner/:repo/:number/events?speed=N` replays `data/events/{owner}/{repo}/{number}.ndjson`, produced by `pnpm --filter @pr-walkthrough/server make-replay <owner> <repo> <number> <runDir...>` from `data/runs/*`. Raw Bob events → `ProgressEvent` (`packages/shared/src/progress.ts`) in `analyzer/progress-normalizer.ts`, the same code for live and replay. Viewer: `ProgressScreen.tsx` at `/:owner/:repo/:number/progress?job=…|replay=1`; landing cards have "Watch the analysis →".

**Intent:** Paste a PR link and watch what Bob is doing right now; at the end get the walkthrough plus its price and duration.

**Design:**
- `POST /api/analyze` returns `{ jobId }` immediately instead of blocking 3+ minutes; an in-memory job map holds status, events and the result (single process, no DB — non-goal).
- `GET /api/jobs/:jobId/events` — SSE. Source is `--format stream-json` from `runBob`: `tool_use` (which tool, which file/search — "Bob is reading `Sidebar.tsx`…"), `spawn_subagent` (sub-agent started), assistant text deltas collapsed to "writing the walkthrough…", `result` (cost, duration). Stages the backend adds: clone/worktree → N hunks (M auto-skipped) → Bob → validate → repair (if any) → done.
- Every run writes `data/runs/<stamp>/events.ndjson` (already done by `runBob`). For cached PRs, `GET /api/runs/:owner/:repo/:number/events` replays the recorded file at accelerated speed, so the screen is demoable at $0.
- Landing page: the URL input already exists (`LandingPage.tsx`) — wire it to `POST /api/analyze` when the PR isn't cached; examples stay one-click.
- Progress screen: live stage list, current Bob action, running cost `$0.42 / max $4`, elapsed time; on `done` → navigate to the viewer.

**✓ Verify:** replay of #10295's recorded events renders the full stage list and ends in the viewer; SSE survives a page reload (reconnect gets the backlog); with `ANALYZER=cached` no Bob process is spawned.

---

### Sub-Task 6d — GitHub round-trip: "Your review" screen

**Status:** [x] done (Sep 26) — Must part built; line comment verified end-to-end on an2323/excalidraw#1. Should-haves (draft review with Submit, bot comment) not built.

**As built:** `GET /api/review/:owner/:repo/:number` → `{enabled, target | reason}`; `POST /api/review/:owner/:repo/:number/comments {body, anchor?}` (`packages/server/src/github/review.ts`). A walkthrough maps to the demo PR only if it equals `GITHUB_DEMO_SOURCE` (default `excalidraw/excalidraw#10295`) **and** the demo PR's head SHA equals the walkthrough's `headSha`. CodeLines have no line numbers, so the backend finds the line in the file at base/head SHA (GitHub contents API) by text + up to 5 same-side neighbours, then checks it against the PR's `/files` patches: inside a hunk → review comment (`line`, `side` LEFT/RIGHT, `commit_id` = head); outside, not found, or a 422 → general comment via the Issues API with a quoted line and a permalink. The anchor's file must be one of the PR's hunks' files. `pnpm --filter @pr-walkthrough/server review:dryrun excalidraw excalidraw 10295` prints where every quoted line would land without posting — all #10295 lines resolve; s3's `useOutsideClick.ts` base block is outside the diff (general-comment path). Viewer: `packages/web/src/review.tsx` (`ReviewProvider`, `LineComposer`); in `CodeFold` hovering a line's gutter shows `+` → inline composer → "Post to an2323/excalidraw#1" (or "Copy comment" when posting is off); the summary screen gets "Post to …" next to "Copy as review comment". `vite.config.ts` proxy target is overridable with `API_TARGET` (used to run a second, token-less stack for the fallback check).

**Verified:** line comment posted from the viewer landed at `styles.scss` line 19 RIGHT ([discussion_r4112143081](https://github.com/an2323/excalidraw/pull/1#discussion_r4112143081)); with `GITHUB_TOKEN_WRITE=` the API says `enabled: false`, POST → 503, the UI shows only copy buttons, no errors, no horizontal scroll at 375 px. The summary "Post" (general comment via the Issues API) was checked by the user by hand.

**Intent:** From inside the walkthrough, write a comment on a line or a question to the author, and it appears in the PR on GitHub.

**Today:** the summary screen (`SummaryScreen.tsx`) collects questions into one text with a **Copy as review comment** button — the reviewer pastes it into GitHub by hand.

**Demo repo — done (Sep 26):** [an2323/excalidraw](https://github.com/an2323/excalidraw), forked from `excalidraw/excalidraw`. PR **[an2323/excalidraw#1](https://github.com/an2323/excalidraw/pull/1)** re-creates #10295 exactly: branches `demo-10295-base`/`demo-10295-head` point at the same `baseSha`/`headSha` the cached walkthrough already uses (no rebasing, no diff drift — both commits already existed in the fork's shared object network, so this took two `git/refs` calls and a `pr create`, no push). `GITHUB_DEMO_REPO=an2323/excalidraw` and `GITHUB_DEMO_PR=1` are in `.env.example`.

**Design:**
- Comment on a code line → PR review comment on that line (`POST /repos/{o}/{r}/pulls/{n}/comments`, `commit_id` = head SHA, `path`, `line`, `side`). Lines outside the diff → a general PR comment (`POST /repos/{o}/{r}/issues/{n}/comments` — a PR is an issue for this endpoint) with a permalink to the line at head SHA.
- "Ask the author" on each open question → same path, pre-filled with the question and the step it points to.
- Backend-only token: fine-grained PAT, "Only select repositories" → `an2323/excalidraw`, **Pull requests: Read and write** + **Issues: Read and write** (the general-comment fallback needs Issues, not just Pull requests). `.env`'s `GITHUB_TOKEN_WRITE`, never sent to the browser. Without it the button falls back to today's copy-to-clipboard. Short expiration (7–14 days) is enough for the hackathon.
- Should: a draft review with Submit (Comment / Approve / Request changes) via `POST /pulls/{n}/reviews`.
- Should: a bot comment on the PR linking to the walkthrough.

**✓ Verify:** a line comment and a question posted from the viewer show up on an2323/excalidraw#1 at the right line; with the token unset the UI shows the copy button and nothing errors.

---

### Sub-Task 6e — Agent-verifier ("Try it in the app")

**Status:** ↩ **back in scope** (Sep 26, user decision) — **deferred until the main items are done**: after ST6g, ST7, ST8, ST9; before ST11 (Railway). Was cut earlier the same day; that cut is reversed. Needs the user's go-ahead (and likely a stage-budget decision) before any paid run.

**Intent:** This is part of the product, not decoration: when a PR is analysed, the system also starts the app at BASE and at HEAD, reproduces the scenario, and records before/after screenshots with the spot to look at highlighted. They land automatically in the first Problem step (the ST6g `shots` visual) — no manual screenshots per PR. **Ideally Bob does it.** First target: Excalidraw only (the user has confirmed local dev servers start and screenshots can be taken).

**Order of work:**
1. ST6g first: manual #10295 screenshots + the `shots` visual with highlight boxes in the viewer. This fixes the output format the verifier must produce, and the demo is safe even if the verifier slips.
2. Main plan items (ST7 narration, ST8, ST9).
3. Then this ST: the verifier fills the same `shots` visual automatically.

**Design:**
- **Bob does the work** in a second custom mode `pr-verifier`, run as a separate `bob run` after the analysis (same checkout, per-PR worktrees): groups `read` + `execute` (+ `browser` if Bob's browser tool can take screenshots reliably — check first; otherwise Bob writes and runs a Playwright script). `execute_command` with `background: true` for dev servers is confirmed to work.
- **Input:** the finished walkthrough (first Problem step, `verification.scenario`, the files touched), plus the recipe for the repo: how to install/start it (Excalidraw: `yarn`, `yarn start`, port). The backend prepares two worktrees (BASE, HEAD) and fixed ports.
- **Bob's job:** start BASE and HEAD, reproduce the scenario (e.g. #10295: open the floating sidebar, then the main menu), take one screenshot per side at desktop width (optionally mobile), and return JSON: `{ before: { file, highlights[] }, after: { file, highlights[] }, caption, steps[] }`, highlights as 0..1 fractions of the image (ST6g schema). Bob picks the highlight region from what changed (DOM element bounding box of the component the PR touches).
- **Backend:** validates the JSON (files exist, sizes, highlights in range), copies images to `data/shots/{owner}/{repo}/{number}/`, writes the `shots` visual into the first Problem step, and always kills the processes Bob started and frees the ports (they outlive the session).
- **Safety:** `execute` runs code from the repository, so: allowlist of repos (Excalidraw only at first), throwaway checkout outside this repo, no secrets in the env of the verifier process, network limited to install, timeout, `--max-cost`. Not exposed as "any PR" in public until ST11's guards exist.
- **Fallback if Bob is unreliable:** the backend runs a per-repo Playwright script for the same scenario and fills the same `shots` visual (no Bobcoins). The format stays the same, so the viewer doesn't care who produced the images.
- **Progress screen (ST6c):** new stages "Starting the app (before/after)" and "Taking screenshots".
- **Cost:** estimated $3–8 per run (unverified). Stage-2 cap is $20 with ~$9.80 left; a verifier run plus retries may need the cap raised — ask the user before the first run and log every run in `docs/cost-log-stage2.md`.

**Until this is done:** #10295's screenshots are the manual ones from ST6g. The "Try it in the app" chapter and the "Tried N of M scenarios" line stay **hidden** via `SHOW_TRY_IT = false` in `packages/web/src/features.ts`.

**Testing without spending on a full analysis (Sep 26, user decision):** no full analysis runs to test this ST. The verifier is a separate step that reads an already-cached walkthrough (`data/walkthroughs/...`), so it can be run on its own: `pnpm --filter @pr-walkthrough/server verify-shots excalidraw/excalidraw#10295` — prepares the BASE/HEAD worktrees, runs only the verifier, writes `data/shots/...` and the `shots` visual. Test in this order:
1. **$0 first:** the backend part with the Playwright fallback (worktrees, starting Excalidraw at BASE and HEAD, the #10295 scenario, screenshots, highlights, cleanup of processes/ports) — no Bob.
2. **Then, only with the user's go-ahead for that specific run:** the same command with Bob as the verifier (`--max-cost` set low), logged in `docs/cost-log-stage2.md`.
Wiring the verifier into the live analysis pipeline (`POST /api/analyze`) is checked with `ANALYZER=cached` + the fallback, never with a paid full run.

**✓ Verify:** the $0 fallback run produces #10295's BASE/HEAD screenshots and leaves no process/port behind; then, with the user's go-ahead, one standalone verifier run on #10295 produces BASE/HEAD screenshots showing the toolbar-over-sidebar bug and its fix, with highlight boxes over the right spot; they appear in step 1 of the viewer; no dev-server process or port is left running afterwards; a second PR from Excalidraw (#8340) works without code changes, or the reason it can't is written down.

---

### Sub-Task 6f — Public demo on Vercel

**Status:** [x] deployed (Sep 26) → **https://pr-walkthrough-bob.vercel.app** (Vercel project `pr-walkthrough`, alias set with `vercel alias set`; SSO deployment protection turned off for this project so judges don't hit a Vercel login — `pr-walkthrough.vercel.app` belongs to someone else). Narration audio is 0/28 (#10295, stale) and 0/26 (#8340, none) until ST7 regenerates it; Web Speech covers it until then.

**As built:** `pnpm build:static` = shared build → `VITE_STATIC=1` web build → `pnpm --filter @pr-walkthrough/server export-static [outDir] [owner/repo#n …]` (default #10295, #8340). `packages/web/src/staticMode.ts` switches walkthrough/audio URLs to `/data/...`; `review.tsx` never calls the API; the landing page hides the URL input and cards with no data; `ProgressScreen` replays `/data/events/…ndjson` in the browser, paced like the server replay (~20 s), so "Watch the analysis →" works in the demo. `vite.config.ts` sets `publicDir: false` in static mode (public/ holds the Outline example). The export script only allows owner `excalidraw`, fails if any `outline` path ends up in the output, copies only mp3s whose hash matches the CURRENT narration + `ELEVENLABS_VOICE_ID` (as `{stepId}/{n}.mp3`), and writes `dist/vercel.json` (SPA rewrite except `/data/` and `/assets/`, which must 404 when missing). Audio probe in `App.tsx` now needs `probe.ok` (a 404 used to mean silence instead of Web Speech). Redeploy (e.g. after ST7 adds audio): `pnpm build:static && cd packages/web/dist && npx vercel link --yes --project pr-walkthrough && npx vercel deploy --prod --yes`, then `npx vercel alias set <new deployment url> pr-walkthrough-bob.vercel.app` (the build wipes `dist/.vercel`, so re-link each time; `vercel link` also drops an OIDC `.env.local` into `dist/` — Vercel doesn't upload `.env.local`, checked, but delete it anyway).

**Verified deployed:** at 400 px, #8340 replay → viewer → all 9 screens, #10295 renders, 0 `/api/*` requests; `/data/.../9403.json` → 404; `/.env.local`, `/.gitignore`, `/outline-13673.walkthrough.json` return only the SPA `index.html`.

**Verified locally** (static server with the same rewrite rules, 416 KB total): landing shows #10295 and #8340 only; #10295 replay runs ~20 s and lands in the viewer; every #8340 screen renders, no JS errors, no "Post" buttons; 0 requests to `/api/*` or any Outline path; no horizontal scroll at 375 px.

**Intent:** Judges open a link and click through the finished walkthroughs themselves, no local setup.

**Design:**
- Viewer in static mode: walkthrough JSON, narration mp3 and screenshots shipped as static files (`/data/...`); no backend. A build flag (`VITE_STATIC=1`) switches `fetch('/api/walkthroughs/...')` to the static paths; the `/api/context` "show more code" drawer is disabled or served from pre-extracted snippets.
- Only Excalidraw PRs (MIT). **Outline is not deployed** (licence unverified).
- Live analysis (ST6c) and GitHub posting (ST6d) are hidden in static mode — the video shows them.

**✓ Verify:** the deployed URL renders #10295 and #8340 with audio, on desktop and at 400 px, with no requests to `/api/*`.

---

### Sub-Task 6g — Before/after screenshots in the first step; map on demand

**Status:** [ ] pending · **Must** · ~2.5 h · 0 Bobcoins · do before ST7 (narration) and ST9 (video)

**Intent:** The reviewer should *see* the bug before reading about it, and the start screen should only answer "what is this PR". The architecture map is an orientation aid, not a review step, so it moves out of the main flow.

**Decisions (Sep 26):**
- **Before/after screenshots → the first Problem step.** For #10295: excalidraw at BASE vs HEAD with the floating sidebar open (toolbar buttons over the sidebar vs under it); optionally the same at mobile width with the menu open. Taken by hand for now; later produced automatically by the verifier (ST6e), in the same format. They are the step's ONE visual (Before | After side by side on desktop, a toggle on mobile), replacing the current visual of that step. Captions in plain words.
- **Highlights drawn by the viewer, not baked into the PNG:** each screenshot gets 1–2 boxes with a short label over the spot to look at — red on Before, green on After, at the same place on both so the change jumps out (#10295: Before "Buttons draw over the sidebar", After "Sidebar is on top"). Boxes, not arrows (arrows are hard to place across widths and cover UI). Coordinates are fractions of the image size, so boxes stay aligned at any width; colours come from the theme tokens (`--bad` / `--good`); labels stay real text (editable, screen-reader friendly); the box can fade in after the image (nice under narration in the video). The PNGs stay clean and can be reused in the README.
- **Schema:** optional on a step (paths relative to `data/shots/{owner}/{repo}/{number}/`):
  ```ts
  visual: {
    type: "shots";
    before: { src: string; highlights?: Highlight[] };
    after:  { src: string; highlights?: Highlight[] };
    caption?: string;
  }
  type Highlight = { x: number; y: number; w: number; h: number; label?: string }; // 0..1 of image size
  ```
  Fallback: the step's existing visual. For the hackathon only #10295 gets shots and highlight coordinates, set by hand in the JSON — the analyzer does not produce them.
- **Static demo:** `export-static` copies `data/shots/...` into `dist/data/shots/...`; re-deploy after (commands in ST6f).
- **Start screen:** title, Problem / Fix, stats, Start / Listen — **no map**.
- **Map on demand — both entry points:** (1) a "How the pieces connect" button available on every screen (top bar or the quiet row) that opens a modal / drawer with the Before/After map; (2) a link to the same modal on the "Your review" summary screen, as the payoff after the flow. Steps with `visual: map` keep their inline map.
- **Fix label overlap in `MapSvg.tsx`:** edge labels are centred on the edge with an estimated width (`length * 6.4`), so long `plainLabel`s spill over the nodes when the gap between columns (150 px) is shorter than the label (see the #10295 "After" view). Fix: measure/clamp the label to the free gap and wrap to two lines or truncate with the full text in the tooltip; widen `GX` when labels are long; prompt rule (ST10 follow-up) — `plainLabel` ≤ ~24 chars. Shorten the #10295 labels by hand now.
- **Consider a "Both" view** (problem path in red and the fix in green on one map) next to Before/After — for review, the change is easier to read in one picture than by toggling.

**Assessment of the map as a review aid (Sep 26):** useful as orientation ("which modules does this touch, what was removed, what was added"), weak as a review tool. On #10295 it mixes two nearly independent fixes (stacking order on the left, outside-click handling on the right) with no link between the clusters; "After" alone hides the problem path; edge labels repeat implementation details that the steps already show with code. Without the steps' context it reads as boxes. Hence: keep it, but on demand, not as the hero of the start screen and not a required screen.

**✓ Verify:** #10295 step 1 shows both screenshots (desktop side by side, mobile toggle, no horizontal scroll at 375 px) with the highlight boxes and labels on the right spot at desktop and 375 px; the start screen has no map; the map button opens the modal from any screen and from the summary, Esc closes it; no edge label overlaps a node on #10295 and #8340 (Before, After, Both); the static build serves the screenshots with no `/api/*` requests.

---

### Sub-Task 7 — Demo data generation and caching

**Status:** [-] mostly done — demo PRs changed from the original draft (#10013 is dropped).

**State (Sep 26):**
- `data/walkthroughs/excalidraw/excalidraw/10295.json` — valid, ST10 iteration-2 result.
- `data/walkthroughs/excalidraw/excalidraw/8340.json` — valid after one `--resume` repair.
- `data/walkthroughs/outline/outline/13673.json` — golden example, local only (not in the public demo, ST6f).
- #9403 — deferred: our stream-json reconstruction fails on its repaired answer (see `docs/cost-log-stage2.md`).
- Replay recordings for the progress screen: `data/events/excalidraw/excalidraw/{10295,8340}.ndjson` (ST6c).
- Every paid run is logged in `docs/cost-log-stage2.md`; stage cap $20, $10.20 spent.

**Todo List:**
1. `ANALYZER=cached pnpm dev` → open #10295, #8340 and Outline; all steps render, no console errors.
2. With the user's go-ahead only: #8340 ST10 confirmation run (~$1–2); #9403 retry once the extractor bug is root-caused.
3. **Deliberately left for last** (Sep 26 decision): regenerate ElevenLabs narration for #10295 (text changed in ST10) and generate it for #8340 (`tts:pregen`) — only once all step text across ST6c/6d/6f/7 is final, so it isn't regenerated twice. With the user's go-ahead only.

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
| Subagents | Confirmed: the read-only `pr-walkthrough` mode spawns parallel `explore` sub-agents for searches — #10295 used 2, #8340 used 4, #9403 used 5 (`docs/cost-log-stage2.md`) |
| Resume | Repairs continue the same Bob session with `bob run --resume <task_id>` instead of a fresh analysis (#8340 repair: $0.34) |
| Custom mode | `pr-walkthrough` read-only Bob Shell mode written into the checkout (`.bob/custom_modes.yaml`) |
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
- A short demo video. Structure: **walkthrough** of #10295 opening on the first step with its before/after screenshots (ST6g) → the rest of the walkthrough with narration → the map modal → **live analysis** progress screen (ST6c) → **comment lands in GitHub** (ST6d). Only Excalidraw PRs on screen.
- End-to-end smoke test: `pnpm dev` starts server + web; opening `http://localhost:5173/excalidraw/excalidraw/10295` renders the full walkthrough; the Vercel link (ST6f) does the same.

**Todo List:**
1. Complete `README.md` (incl. the Vercel link).
2. (Before/after screenshots are taken and wired into the viewer in ST6g.)
3. Record the demo video in the structure above.
4. Run end-to-end smoke test.
5. Fix any final issues.
6. Verify `bob_sessions/` is committed.
7. Submit before Sep 27, 15:00 UTC.

---

### Sub-Task 11 — Live analysis for any PR, hosted on Railway (last step)

**Status:** [ ] pending · **Could** · only once everything else is done and submitted-ready · spends Bobcoins per run

**Intent:** Let anyone paste a PR URL on the public site and get a real Bob Shell analysis, not only the cached examples.

**Why not Vercel:** the pipeline is a long-lived Node process — `bob run` takes minutes (10-min timeout), needs the `bob` CLI, `git` and a persistent clone cache (`GIT_CACHE_DIR`), and keeps jobs in memory for SSE. Vercel functions have short timeouts and no persistent disk, so Vercel stays the static demo (ST6f).

**Design:**
- Railway service from a Dockerfile: Node + `git` + the `bob` CLI, running `packages/server` with a volume mounted at `GIT_CACHE_DIR` and `data/`.
- Env on Railway (never in the repo): `ANALYZER=bob`, `BOB_API_KEY`, `GITHUB_TOKEN` (read), `BOB_BUDGET_USD`, optionally `ELEVENLABS_*`, `GITHUB_TOKEN_WRITE` + demo vars.
- Frontend: a non-static build pointed at the Railway API (API base URL env + CORS for the Vercel domain), or serve the viewer from Railway too.
- Cost guards before going public: one paid job at a time (exists), a per-run `--max-cost`, a total cap, and an allowlist / size limit (e.g. public repos, ≤ N changed files) or a simple access code — an open "paste any PR" box would drain Bobcoins.

**✓ Verify:** with the user's go-ahead for one paid run — paste a small public PR on the deployed site, watch the progress screen, land in a valid walkthrough; a second concurrent request gets 409; a PR over the size limit is refused before Bob starts.

---

### Sub-Task 10 — Analyzer quality iteration

**Status:** [-] nearly done — **2 of 2 allowed prompt-edit iterations done on #10295, converged** (done by Claude Code after Bob IDE hit its limit; do not start ST10 over). #8340 cross-check run intentionally paused (not a technical blocker — budget/priorities call, see below). **Bobcoin budget for this ST: ≤ $10**, of which **~$4.46 spent** (2 iterations: $1.929 + $2.529); stage-2 total cap stays **$20** (the revived ST6e may need a raise — the user decides before its first run), **$10.20 spent overall** — see `docs/cost-log-stage2.md`.

**Iteration results on #10295** (each is `valid: true, errorCount: 0` immediately, no repair needed):

| | Before ST10 | Iter. 1 ($1.93) | Iter. 2 ($2.53) |
|---|---|---|---|
| `identifier-in-say` | 3 | 1 | 0 |
| `missing-check` | 2 | 0 | 0 |
| `headline-too-long` | 2 | 1 | 1 (10 words, one over) |
| `say-too-long` | 1 | 4 (regressed) | 0 |
| **Total warnings** | **8** | **6** | **1** |

Iteration 1 fixed the three prompt/schema/checker number mismatches (headline word limit, say sentence count, the nonexistent `plain.summary` field) — see the `analyzer-prompt.md` commit. That alone improved 3 of 4 categories but regressed `say-too-long` (a 3-sentence habit, including on the `minor` step that should have skipped `say` detail). Iteration 2 added a hard "count your sentences" instruction with a bad/good rewrite of the actual offending step — fixed it to 0 without reintroducing the other regressions. Content re-checked against `docs/rubrics/10295.md` after iteration 2: still correctly names the attribute removal as the decision (not "cleanup"), the wrapper as solving a separate problem, and the type-narrowing step is `minor: true` with no elaborate `say`. Promoted to `data/walkthroughs/excalidraw/excalidraw/10295.json` (schema-valid, renders correctly).

**Remaining for this ST, each needs the user's go-ahead to spend before running:**
- Confirm the same prompt on #8340 (~$1–2) — does the improvement generalize, or was #10295-specific.
- `headline-too-long`'s single remaining case (10 vs. 9 words) is minor; not worth a 3rd prompt iteration per the loop's own 2-iteration cap — accept it or fix opportunistically alongside the #8340 check.

**What is already done — do not re-litigate these:**
- Core-logic-only stepping (`docs/output-contract.md`, `docs/analyzer-prompt.md` "Explain the core logic only") is implemented and evidenced: #8340's 339 hunks (272 mechanical) correctly narrowed to 8 non-minor steps; #10295's earlier bloated 10-step run (see `docs/rubrics/10295.md`) is fixed — the fresh run scores 5/5.
- Subagents (`docs/analyzer-prompt.md` "Using sub-agents for search") work and are used: #10295 used 2, #8340 used 4.
- The plain-language layer is structurally complete on both promoted results — `plain`, `headline`, `say`, `check` (where applicable), `minor`, `visual`, `plainLabel` (6/6 and 8/8 edges), `short` (3/3 questions) are all present. **The gap is wording quality, not field presence** — see below.
- `packages/server/src/validation/quality.ts` (`checkQuality`) already catches every gap listed below automatically, for $0 (run via `spike revalidate`, no Bob call). Use it as the loop's feedback, not manual reading.

**Evidenced gaps — from `checkQuality` on the two real, promoted results (`data/walkthroughs/excalidraw/excalidraw/{10295,8340}.json`):**

| Warning | #10295 | #8340 | Fix in the prompt |
|---|---|---|---|
| `identifier-in-say` | 3 | 7 | `say` still contains backtick-quoted identifiers (e.g. `` `useOutsideClick` ``, `` `informMutation` ``). Add an explicit rule: `say` describes intent only, the way you'd say it out loud to a non-technical teammate — no backticks, no identifiers, no file names, ever. If you can't phrase it without one, the sentence is at the wrong level of detail. |
| `missing-check` | 2 | 3 | Several `change`/`decision` steps have no `check` at all. Add: every non-minor `change`/`decision` step MUST have a `check` — one concrete, verifiable thing (a value, a boundary, an interaction) the reviewer can go test. If nothing new needs verifying, the step is probably `minor` or the wrong kind. |
| `headline-too-long` | 2 | 2 | Headlines run to 10–11 words. Add: ≤ 9 words is a hard limit, not a target — if you can't fit it, you're describing the mechanism instead of the point; simplify or split. |
| `say-too-long` | 1 | 0 | One `say` ran to 3 sentences. Reinforce the existing "one or two short sentences" rule with a concrete bad/good pair in the prompt. |

**New finding from #9403's first `full` run (independent of the extraction bug — see Row C in git log), worth fixing prospectively:** the analyzer's own verbatim quoting was imprecise in ~6 steps (paraphrased variable names, e.g. quoting `newElements: clonedElements` where the real code reads `newElements: duplicatedElements`) — plausibly copied from a subagent's paraphrased summary rather than re-read from the file. Add a rule: **when quoting code, re-read the exact current file content immediately before writing the quote — never rely on memory, a prior mental summary, or a subagent's prose paraphrase as the literal source.** A subagent's report is a pointer to re-read yourself, not a quotable source.

**Loop (budget-conscious, using the free checker between paid runs):**
1. Edit `docs/analyzer-prompt.md` with the rules above (batch all four — one prompt edit, not four).
2. One `full` run on #10295 (smallest, ~$2). `pnpm --filter @pr-walkthrough/server spike full` writes `walkthrough.json`; check it with `spike revalidate` (free) — `checkQuality`'s warning list is the pass/fail signal, not a manual read.
3. If warnings on #10295 drop to ~0, re-run `full` on #8340 (~$1–2) to confirm the fix generalizes; only re-run #9403 if time/budget allow (see below — it needs the extraction fix too, not just a prompt fix).
4. Stop after 2 prompt-edit iterations regardless of outcome — diminishing returns past that for a hackathon deadline.

**Acceptance:** `checkQuality` on a fresh #10295 and #8340 run returns 0 `identifier-in-say`, 0 `missing-check` (on non-minor change/decision steps), 0 `headline-too-long`. `say-too-long` and the verbatim-precision rule are best-effort (no automated check for the latter — spot-read one or two quoted blocks against the real file).

**Separate from this ST — do not conflate:** #9403 is blocked on a bug in *our own* `findWalkthroughInEvents` (stream-json reconstruction corrupts on its ~40KB repaired response; see `docs/cost-log-stage2.md`, 2026-09-26 16:04 row), not on Bob's output quality — Bob's repaired answer was correct. Track re-attempting #9403 as its own item once that extractor bug is root-caused; it is not part of this ST's acceptance criteria.

---

## Resolved Questions

| Question | Answer |
|---|---|
| Bob Shell non-interactive invocation | Verified at runtime (ST5a spike + stage-2 runs): `bob run --format stream-json` with the custom mode, see "Bob Shell Analyzer Design" |
| Solo or team? | Solo developer, sequential tasks |
| Outline licence | Unverified — not deployed in the public demo (ST6f); private test data only |
| LLM fallback if Bobcoins run out | ✂ Cut. `CachedAnalyzer` covers the demo; the stage-2 budget guard ($20) prevents running out mid-demo |
| Narration language | English only |
| Before/after for #10295 | Two screenshots taken by hand (BASE/HEAD), shown as the visual of the first Problem step (ST6g) and reused in the video/README; later produced automatically by Bob (ST6e, Excalidraw first) |
| Automated before/after screenshots | Back in scope: Bob starts BASE/HEAD, reproduces the scenario, returns screenshots + highlights (ST6e), after the main items and before ST11 |
| Where the map lives | Off the start screen; on demand via a button on every screen + a link on the summary (ST6g) |
| Live analysis of any PR in public | Railway backend, as the very last step (ST11); Vercel stays static |
| Live GitHub webhook | ✂ Cut. ST6d posts comments via the REST API instead; a bot comment is a "should" |
| Stage-2 Bobcoin cap | $20, unchanged ($10.20 spent as of Sep 26) |

---

## Bob Shell Analyzer Design

Verified against Bob Shell 2.0.5 (`bob run --help`, the bundled mode definitions,
bob.ibm.com/docs/shell) and confirmed at runtime by the ST5a spike and the stage-2 runs
(`docs/cost-log.md`, `docs/cost-log-stage2.md`).

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
- A project-level custom mode in `<workspace>/.bob/custom_modes.yaml` **is** picked up
  with `--workspace` (confirmed by the `readonly` spike).
- `--format stream-json` emits one JSON event per line, in real time: `message`
  (role `user` echoes the full prompt — ignore it; role `assistant` = text deltas),
  `tool_use` (`tool_name` + parameters, e.g. which file is read; `spawn_subagent` =
  a sub-agent start), `tool_result`, `error` (`message`), and a final `result` with
  `stats { task_id, duration_ms, session_costs, max_cost, tool_calls }`. This is the
  source for the ST6c progress screen.
- `--resume <task_id>`: the follow-up prompt must be a **trailing positional arg** (stdin
  is ignored and the transcript is replayed at $0); `--workspace` must be the exact
  original string; `--max-cost` and `stats` are **cumulative per task**, so a repair's
  cap is `previous cost + repair budget`.
- In a mode with `execute`, `execute_command` supports `background: true` (Bob starts a
  server, gets a pid, can curl it). Processes Bob starts **outlive the session** and keep
  their port — whoever uses this must kill them after the run. Not used by the analyzer
  (read-only); this is what the verifier (ST6e) relies on.

**Design:**
1. Read-only via a custom mode written into the checkout as
   `.bob/custom_modes.yaml`: slug `pr-walkthrough`, `groups: [read, subagent]`,
   `allowedSubagents: ["explore"]`, reviewer role. No shell, no edit.
   `BOB_SUBAGENTS=0` falls back to `groups: [read]` + `--disable-subagents`.
2. No shell means no `git`, so the backend writes a sidecar into the checkout:
   `.walkthrough/base/<path>` (changed files at BASE), `.walkthrough/pr.diff`,
   `.walkthrough/commits.txt`. Both `.walkthrough/` and `.bob/` go into
   `.git/info/exclude` (the shared `$GIT_COMMON_DIR` one). The prompt
   (`docs/analyzer-prompt.md`) describes this layout.
3. One git worktree per PR (`<cache>/<owner>__<repo>/wt/<headSha>`) on a shared blobless
   clone, so runs for different PRs can go in parallel and `/api/context` reads the
   right head.
4. Invocation:
   ```ts
   spawn("bob", [
     "run", "--format", "stream-json", "--mode", "pr-walkthrough",
     "--workspace", repoPath, "--max-cost", MAX_COST, "--max-turns", "40",
     "--disable-mcp", "--trust", "--accept-license",
   ], { cwd: repoPath, timeout: 600_000 });   // prompt written to stdin
   ```
   Every event line is saved to `data/runs/<stamp>/events.ndjson`.
5. Output: the walkthrough is reconstructed from **assistant** text deltas only, then the
   first balanced `{…}` object is parsed. `normalizeDraft` coerces small type slips
   (e.g. `minor: "true"`).
6. Backend sets `pr`, `hunks`, `coverage`, `meta.run` (cost, duration, tool calls,
   sub-agents, repairs, task id), then runs `validate()`. On failure: one repair via
   `--resume` with the structured error list, under the cumulative cap and the stage
   budget guard (`analyzer/budget.ts`, `BOB_BUDGET_USD=20`).
7. `checkQuality` adds non-blocking warnings (identifiers in plain text, lengths,
   missing `check`, step budget); used as the free feedback loop in ST10.

Reference implementation: `packages/server/scripts/bob-spike.ts`.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Bob Shell wraps / mixes the JSON with prose | Medium | Balanced-brace extractor over assistant `stream-json` deltas; raw events saved in `data/runs/` (open: #9403's repaired answer fails reconstruction ~7.7 KB in) |
| A run burns more Bobcoins than expected | Medium | Always pass `--max-cost`; `smoke` spike measures the floor cost first |
| Custom mode not picked up → Bob runs in `agent` mode with edit + shell pre-approved | Medium | `readonly` spike run; checkout lives in a throwaway cache dir, never in this repo |
| Bob Shell produces invalid JSON or hallucinates code lines | Medium | Validation + one repair retry; golden example in prompt as few-shot reference |
| Bobcoin budget runs out before demo PRs are generated | Medium | Generate `#10295` first (5 files, +19−7); CachedAnalyzer for demo runs; stage budget guard refuses runs that could exceed $20 |
| `outline/outline` licence unverified | Confirmed risk | Exclude from public demo; use only Excalidraw PRs (MIT); outline is private test data |
| Excalidraw doesn't build at old commits for the before/after screenshots | Medium | Manual #10295 screenshots from ST6g keep the demo safe; the verifier (ST6e) reports "could not start BASE" instead of failing the walkthrough |
| Verifier runs repository code (`execute`) | Medium | Repo allowlist (Excalidraw first), throwaway checkout, no secrets in its env, timeout + `--max-cost`, backend kills leftover processes (ST6e) |
| Verifier is unreliable or too expensive | Medium | Same output format from a per-repo Playwright fallback run by the backend (no Bobcoins) |
| GitHub write token leaks or posts to upstream | Low | Fine-grained PAT scoped to the demo fork only, backend-only, `.env` gitignored (ST6d) |
| Static Vercel build drifts from the API-backed viewer | Low | One code path with a `VITE_STATIC` switch; verify both before submitting (ST6f) |
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

### Phase 3 — From Sep 26 (after ST5–ST6b and the ST10 iterations)

```
ST1–ST6b  ✓ done        ST10  ✓ 2/2 iterations on #10295 ($10.20 of $20 spent)
     │
     ▼
ST6c  Live analysis: job queue + SSE progress screen   (replay at $0)
     │
     ▼
ST6d  GitHub round-trip: line comments / questions → PR (needs fork + token from the user)
     │
     ▼
ST6f  Public demo on Vercel (static, Excalidraw only)   ✓ deployed
     │
     ▼
ST6g  Before/after screenshots in step 1; map on demand; label-overlap fix
     │
     ▼
ST7   Demo data + narration   →   ST8 / ST9  screenshots, README, video, submit
     │
     ▼
ST6e  Verifier: Bob starts BASE/HEAD and takes the before/after screenshots (Excalidraw first; paid, needs go-ahead)
     │
     ▼
ST11  Live analysis for any PR on Railway (last)
Paid runs (each needs the user's go-ahead): #8340 ST10 confirmation ~$1–2, #9403 retry
```

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
| M6a | Viewer v2 (agreed UX) renders both demo PRs from the API | 0 |
| M6b | Narration audio pre-generated for demo PRs, served from disk | ElevenLabs credits only |
| M6.5 | ✓ ST5a spike: smoke + readonly + full run on `#10295`, numbers in `docs/cost-log.md` | $3.15 spent |
| M7 | BobShellAnalyzer (ported from the spike) wired into the server | 0 (verify with cached) |
| M7.5 | ✓ ST10: 2 prompt iterations on #10295, 8 → 1 quality warnings; #10295 and #8340 valid and cached | $10.20 of $20 spent (stage 2) |
| M7.6 | ST6c: live analysis with SSE progress screen (replay works at $0) | 0 (one real run optional) |
| M7.7 | ST6d: comment/question from the viewer appears on the demo fork's PR | 0 |
| M7.8 | ST6f: public Vercel link renders the Excalidraw walkthroughs with audio | 0 |
| M7.9 | ST6g: #10295 step 1 shows before/after screenshots; map opens on demand, no label overlap | 0 |
| M8 | All demo PRs cached; full stack demo working | #8340 confirmation ~$1–2; #9403 retry if budget allows |
| M9 | Submission: bob_sessions, README, demo video, smoke test | 0 |
| M9.5 | ST6e: Bob-produced before/after screenshots with highlights in step 1 (Excalidraw) | $0 for the fallback; a standalone verifier run (no full analysis) ~$3–8 estimate, with the user's go-ahead |
| M10 | ST11: public live analysis on Railway | per run, with the user's go-ahead |
