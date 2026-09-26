# PR Walkthrough — product brief for planning

> **For Bob:** read this whole file and the files it references before answering.
> Your task in this session is to produce an **implementation plan** (section 14),
> not code. Challenge anything here that looks wrong or too big for 48 hours.

## Files in this folder

| File | What it is |
|---|---|
| `BRIEF.md` | This document: problem, product, principles, architecture proposal, scope |
| `schema/walkthrough.ts` | The JSON contract between the analyzer and the rest of the system |
| `examples/outline-13673.walkthrough.json` | A complete, hand-verified "golden" output for a real PR |
| `prototypes/walkthrough-viewer.html` | A working single-file prototype of the reviewer UI that renders the golden JSON. Open it in a browser. |
| `prompts/analyzer-prompt.md` | Draft of the runtime prompt the product sends to the analyzer |

---

## 1. Context and constraints

- Event: **IBM Bob 2.0 Hackathon** (lablab.ai × IBM), online, 48 hours,
  **Sep 25–27, 2026**, submissions close **Sep 27, 15:00 UTC**.
- Official challenge (summary): improve one specific developer workflow
  (onboarding, debugging, **code review**, testing, maintenance, release). Define a
  problem where time/effort/errors are too high, build a working prototype on a real
  or sample project with IBM Bob 2.0, use features like Agent mode, parallel tasks,
  subagents and document understanding to manage multiple steps (not just assist with
  coding), and clearly demonstrate impact.
- **Bob IDE must be a core component** of the solution to be eligible for judging.
- Every participant must add **Bob IDE task session summary screenshots** (PNG) to a
  `bob_sessions/` folder in the repo, named like `teamname_task01_short_description.png`.
- Budget: **40 Bobcoins per participant**, no top-ups. When they run out we may continue
  with other tools (confirmed by mentors) and optional watsonx products.
- Data rules: our own or public data only; public sources must allow commercial use and
  be listed; no client data, no personal information, no social media data.
- Stack: **Node.js + TypeScript backend, React frontend.**

## 2. The problem

AI now writes a large share of code, and the bottleneck has moved from writing code to
reviewing it. Published 2026 data that motivates this project:

- Faros AI telemetry across ~22,000 developers: median code review time up ~441%
  while task throughput rose ~34% ("The Acceleration Whiplash", 2026).
- LinearB 2026 benchmarks (reported by Codacy): agentic-AI PRs wait ~5.3× longer to be
  picked up for review than unassisted PRs.
- Reviewers of AI-generated PRs receive a finished diff without the decision trail and
  must reconstruct intent from the ticket, the description and the code.

Existing AI review bots (CodeRabbit, Copilot review, Qodo, Greptile…) are good at
flagging risky lines and summarising *what* changed. What they don't give the reviewer is
the thing you get when you call the author and say "walk me through what you did":
**why** the code was like this, what exactly broke, what the author tried, why this
solution and not another, and whether it actually makes sense.

## 3. The product in one paragraph

When a PR is opened, the product analyses it **with access to the whole repository**
(not just the diff) and produces an **interactive walkthrough**: an ordered route of
steps that follows the author's reasoning, a small graph of the files involved that
evolves step by step, code shown **in context** with notes only on the lines that
matter, concrete value traces that show what breaks, honesty tags on every claim, a
list of questions to ask the author, a coverage check that nothing in the diff was left
unexplained, and a **narrated mode** where a voice explains each step in plain language
while the reviewer looks at the code.

Target user: a reviewer who doesn't know this part of the codebase and wants to
understand and judge a PR in minutes instead of reconstructing it alone.

## 4. User flow

1. A PR is opened or updated on GitHub → webhook hits our backend.
2. Backend fetches PR metadata, checks out the repo at base and head, parses the diff
   into hunks with stable ids.
3. Backend runs the **analyzer** (Bob Shell, non-interactive) with the prompt in
   `prompts/analyzer-prompt.md`. The analyzer explores the repo read-only and returns
   walkthrough JSON.
4. Backend **validates** the JSON (schema + verbatim code check + coverage), stores it,
   and (optionally) posts a link as a PR comment.
5. Reviewer opens the link → walkthrough viewer. They can click through steps, or press
   play and listen while the view advances.
6. Stretch: ask follow-up questions about any step/line (Q&A), and before/after videos
   of the bug for UI bugs.

For the demo, step 1 can be replaced by "paste a PR URL", and results can be
pre-generated and cached (see section 11).

## 5. Principles — the core of the product

These were worked out by hand on three real PRs. They are the product's "secret sauce";
the plan must preserve all of them.

### 5.1 Order by reasoning, not by diff
Git shows files alphabetically. A walkthrough follows the questions a developer would
ask: *symptom → cause → constraint (why the obvious local fix isn't enough) → where the
data lives → key decision → changes → dead ends / rejected alternatives →
verification.* Revisiting a file in a later step is normal and expected. In the golden
example the route goes ChangesNavigation → Header → RevisionViewer → DocumentContext →
Diff → RevisionViewer → DocumentContext → RevisionViewer → ChangesNavigation.

### 5.2 One step = one decision or one question
Not one file. 5–12 steps per PR. Each step has a `kind` (see schema).

### 5.3 Three beats per step: current → problem → change
A bare diff line (`query.get` → `query.has`) is meaningless without context. Each step
explains, when relevant:

- **How it works now** — base code *around* the change, plus the *other place* that
  uses the same value. Example: the counter reads `query.get("changes")`, while
  `RevisionViewer` reads the same parameter with `query.has("changes")`.
- **What breaks** — with concrete values, as a trace:
  `URL …?changes → get("changes") → "" → return null` versus
  `URL …?changes → has("changes") → true → highlights built`.
- **What we change** — the edit, quoted in the same context, and what it changes.

### 5.4 Annotate only load-bearing lines
A note (`↳ …`) goes under a line only if a different choice would change behaviour:
conditions/boundaries, ordering, timing, concurrency, effect lifetimes, removal of
something that used to work, deviation from codebase conventions, shared contracts.
Max 3 per code block. Imports, renames, types and boilerplate are never annotated.

### 5.5 Honesty tags on every claim
Every step and optional per-line annotation is tagged:
`fact` (visible in code/diff/comment/test), `commit_history` (stated in commits),
`inferred` (analyzer's own conclusion), `unverified` (scenario not executed).
In the golden example the "stuck counter" mechanism and the intermediate flicker code
are `inferred`, because the author never described them. **An inference must never be
shown as a fact.** Without these tags the tool confidently explains wrong things, which
is worse than no explanation.

### 5.6 Dead ends and rejected alternatives
Commit history (including the bullet list inside squash-merge messages) reveals what the
author tried first. Example: "Reset changes count only on unmount to avoid flicker"
reveals an earlier version that flickered. These appear as struck-through steps in the
route.

### 5.7 Two levels of language
- `narration` — spoken by TTS, 2–4 sentences, plain language, **no identifiers**,
  explains intent ("the count doesn't need the editor at all, so we compute it from the
  data we already have").
- `text` / `annotation` — precise, may reference `identifiers`.
The reviewer reads low-level code while hearing the high-level intent.

### 5.8 Coverage — nothing hidden
Every diff hunk must be referenced by a step or listed in `skippedHunks` with a reason
("removed unused import"). The **backend** computes coverage; anything unaccounted for is
shown as "not explained". This guards against the scariest failure: a nice explanation
that silently omits a change.

### 5.9 Verbatim code check
Quoted code lines must exist verbatim in the base or head file (except `elided` lines
and blocks marked `reconstructed`). The **backend** verifies this and rejects or repairs
output that quotes code that doesn't exist. This was tested on the golden example:
74 of 74 quoted lines matched the real files.

### 5.10 Questions for the author
The analyzer lists 0–4 questions a careful reviewer should ask: silent failure paths,
unmentioned behaviour changes, logic duplicated in two places, environment assumptions.
Example from Excalidraw #10013: after the change, dragging a library item into another
editor instance with a different library would silently insert nothing.

### 5.11 An evolving graph
4–8 nodes (files/modules) with edges (props, calls, data flow). Edges removed by the PR
fade out, new edges appear at the step that introduces them (`visibleFrom` /
`visibleUntil`). A dashed "hop" arrow shows where the reasoning moved from the previous
step. See the prototype.

## 6. What the analyzer needs (it's not just the diff)

The value came from information *outside* the diff. For the golden example, the key
explanation of why the editor appears late was in a code comment in an **unchanged**
part of `RevisionViewer.tsx`, and three of eleven steps rely on commit titles. The
analyzer needs:

1. Diff, pre-parsed into hunks with ids (`file#n`).
2. Base and head versions of every changed file.
3. Usages of changed symbols across the repo (grep / TS-aware search).
4. Commit titles and messages; for squash merges, the bullet list in the message.
5. PR title, description, linked issues.
6. Changed/added tests.
7. Code comments near the changes.

**Bob Shell** is a strong fit because it is an agent with tools: given read-only
access to the checkout, it decides itself what to open and search, and Bob 2.0 can
spawn subagents for independent investigations (e.g. "where is this value read?").
A stateless LLM fallback needs our backend to gather items 1–7 up front.

## 7. Proposed architecture (to be validated by you)

```
repo/
  packages/shared/      walkthrough schema (TS types + zod), hunk id helpers
  packages/server/      Node/TS: webhook, jobs, git/diff, analyzers, validation, storage, API
  packages/web/         React viewer (port of prototypes/walkthrough-viewer.html)
  data/walkthroughs/    cached JSON results (demo mode reads from here)
  bob_sessions/         required hackathon screenshots
  docs/                 this brief
```

Key server modules:

- **GitHub adapter** — webhook handler (`pull_request` opened/synchronize) and a manual
  `POST /api/analyze { prUrl }`. Local webhook testing via a tunnel (smee.io or similar).
- **Repo workspace** — clone/fetch, checkout head, resolve base; read-only for the
  analyzer.
- **Diff parser** — hunks with stable ids and +/− counts.
- **Analyzer interface** with swappable implementations:

  ```ts
  interface Analyzer {
    analyze(input: AnalyzerInput): Promise<WalkthroughDraft>;
  }
  // BobShellAnalyzer  — primary; runs Bob Shell non-interactively in the checkout
  // LlmAnalyzer       — fallback (Claude API or watsonx.ai) with pre-collected context
  // CachedAnalyzer    — returns stored JSON (demo mode, zero cost)
  ```
  Selected by env var, e.g. `ANALYZER=bob|llm|cached`.
- **Validator** — zod schema check; verbatim-line check against base/head; coverage
  computation; a single "repair" retry that sends validation errors back to the
  analyzer.
- **Storage** — JSON files on disk are enough.
- **API** — `GET /api/walkthroughs/:owner/:repo/:number`.
- **Optional PR comment** with the link.

Web:

- React port of the prototype: route rail, graph, step view with beats, code blocks
  with annotations and tags, traces, notes, open questions, coverage panel.
- Graph layout: use node `layout` hints if present, otherwise auto-layout (e.g. dagre
  or elkjs).
- Narration: Web Speech API first (already works in the prototype); pre-generated audio
  files are a nice-to-have.

## 8. Output contract

See `schema/walkthrough.ts`. Division of responsibility:

- The **analyzer** decides order, meaning, narration, annotations, tags, graph, open
  questions, and maps steps to hunk ids.
- The **backend** owns facts it can compute: PR metadata, hunks, coverage, verbatim
  checks. The analyzer must not invent these.

## 9. Golden example and demo PRs

All three were analysed by hand. Licences must be checked before use in the demo
(Excalidraw is MIT; please verify Outline's licence terms).

1. **outline/outline #13673** — "History changes indicator missing on load and stuck on
   'N changes'". React + MobX, 6 files, +71 −44, 4 commits squashed. Fully worked out in
   `examples/`. Great for the walkthrough: non-linear route, a key insight (the count
   doesn't need the editor), a dead end from commit history. Hard to run locally
   (Postgres, Redis, auth), so **no video** planned.
2. **excalidraw/excalidraw #10013** — "Race conditions when adding many library items".
   6 files, 12 commits squashed. Dragging from the library now carries only item ids;
   the canvas fetches items from the library and duplicates them on drop. Great for
   **questions to the author** (duplication now lives in two places; unknown ids fail
   silently; legacy JSON is now duplicated too). The exact bug symptom is not described
   in the PR, so a video is risky.
3. **excalidraw/excalidraw #10295** — "close floating sidebar on main menu open".
   5 files, +19 −7. **Best candidate for a before/after video**: Excalidraw runs locally
   without a backend. The diff removes `data-prevent-outside-click` from the menu
   trigger, wraps the menu in a `.dropdown-menu-container` with `display: contents`,
   makes the menu's outside-click handler ignore clicks inside that container, and
   raises the library sidebar z-index (80 → 120). Hypothesis to verify first: the
   trigger was excluded from outside-click handling, so opening the main menu did not
   close a floating library sidebar. Repro idea: open the library sidebar undocked,
   click the main menu → base: both open; head: sidebar closes.

## 10. Before/after video (stretch)

For UI bugs: start the app at base, run a Playwright script that reproduces the
symptom with slowMo and recording on; switch to head; run the same script. Show both
side by side at the top of the walkthrough. Video is context for the reviewer, not the
proof — the proof is a scenario that fails on base and passes on head. For the demo, a
manually recorded video is acceptable if we say so.

## 11. Demo strategy and cost control

- Pre-generate walkthroughs for the demo PRs once with Bob Shell, store the JSON,
  and demo from cache. Live generation is shown only if time allows.
- Develop the analyzer prompt on the smallest PR first (#10295), then the others.
- Log Bobcoin usage per analysis run so we know the cost of one walkthrough.
- If Bobcoins run out: switch to `LlmAnalyzer`; keep the Bob-generated results as the
  showcase.
- Impact measurement for the pitch: a small experiment inside the team — review a PR
  with the raw diff vs with the walkthrough; record time to verdict, number of
  clarifying questions, and whether a planted doubtful change was noticed.

## 12. Scope and priorities

**Must (the demo fails without these)**
1. Analyzer produces valid walkthrough JSON for at least 2 real PRs.
2. Backend validation: schema, verbatim lines, coverage.
3. React viewer with route, graph, beats, code in context, tags, open questions,
   coverage.
4. Narrated mode (Web Speech API).
5. Manual trigger (`POST /api/analyze` or CLI) and cached demo mode.
6. `bob_sessions/` screenshots, README, demo video.

**Should**
7. GitHub webhook + PR comment with link.
8. LLM fallback analyzer.
9. Before/after video for Excalidraw #10295.

**Could**
10. Q&A on any step/line.
11. Pre-generated audio.
12. Running the analyzer inside Bob IDE as a custom mode / skill (`/walkthrough <PR url>`)
    so the same capability is usable interactively.

**Won't (this hackathon)**
Auth, multi-tenant, databases, private repos, non-GitHub hosts.

## 13. Unknowns to resolve first (first 2–3 hours)

1. Exact Bob Shell non-interactive invocation: flags, how to pass a long prompt, how to
   restrict it to read-only, how to capture pure JSON output, timeouts, exit codes,
   headless authentication. Check the Bob Shell docs (non-interactive sessions,
   configuration, modes).
2. Cost and duration of one analysis run on the golden PR.
3. Whether Excalidraw builds and runs locally at the two commits of #10295, and whether
   the bug reproduces.
4. GitHub API access with a token (unauthenticated rate limits are hit quickly).

## 14. What I need from you now

Produce a plan in markdown with these sections. **Do not write implementation code
yet.**

1. **Your understanding** of the product in 5 bullet points, and anything in this brief
   you disagree with or find risky.
2. **Architecture**: final repo layout, modules and their interfaces (TypeScript
   signatures), data flow diagram (mermaid).
3. **Analyzer design**: how Bob Shell is invoked, how the prompt and schema are
   delivered, how you ensure JSON-only output, read-only access, timeouts, retries and
   the repair loop. How subagents could be used inside the analysis.
4. **Validation**: schema, verbatim check (including whitespace handling), coverage.
5. **Viewer**: React component tree, state, how the prototype maps to components, graph
   layout approach.
6. **Which Bob 2.0 features you will use while building, and where** (Plan mode, Agent
   mode, subagents, parallel/background tasks, Workflows, custom modes, skills, rollback,
   `/init` + AGENTS.md, Bob Shell). We need this to be visible to the judges.
7. **Milestones** with hour estimates across the remaining ~44 hours, ordered by the
   priorities above, with a rough Bobcoin estimate per milestone.
8. **Task split** for a team (assume 2–3 people unless told otherwise) so work can
   run in parallel without conflicts.
9. **Risks and mitigations**, especially for the unknowns in section 13.
10. **Questions for me** — anything you need decided before implementation.
