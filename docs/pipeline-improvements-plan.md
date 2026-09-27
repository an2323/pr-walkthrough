# Pipeline improvements plan

**Primary goal: raise walkthrough quality** — correct causal claims, reliable capture of
Bob’s output, prose that matches the output contract, honest presentation when evidence
isn’t available.

Budget and deadlines are **constraints** (how we schedule work), not the objective.
Saving Bobcoins is only useful insofar as it frees capacity for quality work (revise,
critic, repairs) — never by weakening the main analysis.

**Constraints (handoff):**
- ~$2.99 left under the $28 stage-2 cap; any paid run needs explicit go-ahead.
- First `full` analysis stays thorough (prompt depth, subagents, generous
  `MAX_COST` / `MAX_TURNS`). No “cheap draft” mode.
- Demo deadline may force a ship line — prefer shipping quality loops that fix wrong
  explanations over cosmetic spend-saving.

**Non-goals:**
- Optimizing for lower cost on the main analysis
- Cheap first draft → polish later
- Disabling subagents or cutting turns to save cents

---

## What “higher quality” means here

| Dimension | Today’s gap | Improvement |
|-----------|-------------|-------------|
| **Correctness** | Ablation can contradict steps; revise is manual | Auto-revise so shipped prose matches measured evidence |
| **Prose / contract** | `checkQuality` warns only; bad `say` can ship | One resume pass on critical quality codes |
| **Fidelity of capture** | Good drafts lost to JSON extract bugs → wrong/missing WT | Write-to-file + hardened extract so quality isn’t thrown away |
| **Non-visual PRs** | No second look; only `inferred` | Claim critic (or honest “not measured”) instead of silent weakness |
| **Trust / honesty** | No-shots UI is silent; verifier may run on perf | Clear status; don’t imply evidence we don’t have |

---

## Target pipeline (desired end state)

```
analyze (full-quality Bob — unchanged ambition)
  → validate (schema + verbatim + line numbers + coverage)
  → 1× schema/verbatim repair via --resume          [exists]
  → 1× quality repair via --resume (critical codes) [NEW — prose quality]
  → save
  → if screenshotable (recipe + change looks UI-visible):
        verify shots + confirm repro
        → ablation ($0 measurement)
        → if evidence contradicts steps: revise via --resume  [NEW — correctness]
        → re-validate → save
    else:
        mark verification skipped with honest reason
        optionally: claim-critic pass for mechanism claims   [NEW — non-visual quality]
  → done (quality warnings on job; critical ones already repaired once)
```

Viewer already works with or without `shots` (#8340). Quality work must not assume screenshots.

---

## Work items (ordered by quality impact)

### Q1 — Wire evidence revise into live analyze  ← highest correctness impact

**Quality win:** Shipped steps stop saying things ablation already disproved
(demonstrated manually on #10943).

**Problem:** Pipeline stamps `step.evidence` but does not rewrite contradicted prose.
Wrong causal claims can remain in the walkthrough judges read.

**Do:**
1. Extract revise logic from `scripts/bob-revise.ts` → `src/verify/revise.ts`.
2. After ablation in `analyze-pipeline.ts`, if verdicts contradict step claims
   (same rules as the script), `--resume` with the ablation table + measured facts.
3. Re-validate; on success keep shots/ablation, re-derive evidence, save.
   On failure keep pre-revise draft (never overwrite good with broken).
4. Progress: `"Revising the explanation"`. Env: `VERIFY_REVISE=0` to disable.
5. CLI `bob:revise` becomes a thin wrapper.

**Budget note:** Implementing is free; running revise spends Bobcoins — worth it when
evidence contradicts, because that is direct quality.

**Files:** `bob-revise.ts`, `verify/revise.ts`, `analyze-pipeline.ts`, `bob-shell.ts`.

---

### Q2 — One quality repair via `--resume`  ← prose / contract quality

**Quality win:** Identifiers in narration, “ablation confirms…” in `say`, etc. get fixed
automatically instead of shipping or needing hand edits.

**Do:**
1. `CRITICAL_QUALITY_CODES`: e.g. `identifier-in-say`, `identifier-in-headline`,
   `narration-mentions-process` (not soft length warnings).
2. After validate + `checkQuality`, if critical codes + `taskId` → one structured
   `--resume` (same pattern as `repairBob`).
3. Re-validate; if worse, keep previous draft.
4. Never start a new `full` for quality nits — resume preserves the good analysis and
   only fixes the listed issues.

**Files:** `validation/quality.ts`, `bob-shell.ts`, `analyze-pipeline.ts` or analyzer.

---

### Q3 — Reliable extract / write-to-file  ← don’t lose quality we already paid for

**Quality win:** A strong analysis that Bob already produced actually becomes the
walkthrough. Extract failures currently force retries or leave invalid/missing output —
that is a quality failure, not a cost issue.

**Do:**
1. Prefer Bob writing final JSON to `.walkthrough/out/walkthrough.json` (scoped write
   if mode must stay mostly read-only); backend reads file first.
2. Harden `findWalkthroughInEvents`; always persist raw assistant text for re-extract.
3. On extract failure with `taskId`: one resume “emit the same JSON to the out path”
   before failing — recovers quality without re-reasoning the PR from scratch.

**Files:** `bob-shell.ts`, `analyzer-prompt.md`, custom mode writer, sidecar helpers.

---

### Q4 — Claim critic for non-visual PRs  ← quality where screenshots can’t help

**Quality win:** Perf/refactor walkthroughs (#8340-class) get an independent check of
mechanism claims (supported / unsupported / contradicted with file:line), then the same
revise path. Without this, non-visual quality plateaus at “Bob’s first reading.”

**Do:**
1. Read-only `pr-critic` mode (plan ST12-D'): list claims per step, classify, write
   `verification.review`.
2. Contradictions → revise (same module as Q1).
3. Skip critic when ablation already ran (visual path).
4. Viewer: show “reviewed against the code” distinctly from “measured in the running app.”

**Budget note:** This spends Bobcoins on purpose for quality on PRs ablation can’t cover.
Prioritize after Q1–Q3 if demo time is tight; do not drop it from the quality roadmap.

**Files:** new critic runner + mode, `analyze-pipeline.ts`, viewer chips/copy.

---

### Q5 — Honest UX when evidence is absent  ← trust quality

**Quality win:** Reviewers aren’t misled into thinking screenshots or measurement failed
silently. Honesty is part of product quality.

**Do:**
1. StartScreen: if `!shots`, one muted line from skip reason or default
   (“No before/after — this change isn’t visible in the UI”).
2. Progress: show skip / revise reasons clearly.
3. Landing: never badge “evidence-checked” without ablation; optional clear “no screenshots”.
4. Never invent placeholder images.

**Files:** `StartScreen.tsx`, `ProgressScreen.tsx`, `LandingPage.tsx` as needed.

---

### Q6 — When to attempt screenshots (quality of the evidence path)

**Quality win:** Don’t run the screenshot/repro path on changes that can’t produce a
meaningful visual signal — avoids weak or misleading “verification” and keeps the
verifier focused on PRs where measured evidence actually improves explanation quality.
(Secondary: those Bobcoins can fund Q1/Q4 instead.)

**Do:**
1. `shouldAttemptShots(walkthrough)` before `verifyShots`.
2. Strong skip signals only (perf/refactor + no UI files, etc.). **When unsure → attempt**
   (never skip a real UI bug for thrift).
3. On skip: `verification.status = skipped` + reason; Bob’s `skip.json` remains fallback.

**Files:** `verify/should-attempt-shots.ts`, `analyze-pipeline.ts`.

---

## Suggested order (by quality impact)

| Order | Item | Quality lever |
|------:|------|----------------|
| 1 | **Q1** Evidence revise in live pipeline | Correctness of causal story |
| 2 | **Q2** Critical quality `--resume` | Narration / contract compliance |
| 3 | **Q3** Extract / write-to-file | Keep the good analysis |
| 4 | **Q4** Claim critic (non-visual) | Second look where ablation can’t |
| 5 | **Q5** Honest no-shots UX | Trust |
| 6 | **Q6** Screenshot attempt gate | Evidence only when meaningful |

**Hackathon ship line (if time-boxed):** land **Q1 + Q2 + Q5** for the correctness + prose
+ honesty story; **Q3** if extract still burns runs; **Q4** next for #8340 depth; **Q6**
as supporting hygiene.

### Status (implemented in code)

| Item | Status |
|------|--------|
| Q1 Evidence revise in live pipeline | done (`verify/revise.ts` + `analyze-pipeline`) |
| Q2 Critical quality `--resume` | done (`qualityRepairBob` + pipeline) |
| Q3 Extract / write-to-file | not yet |
| Q4 Claim critic | not yet |
| Q5 Honest no-shots UX | done (`StartScreen` + landing badge) |
| Q6 Screenshot attempt gate | done (`should-attempt-shots.ts`) |

Env toggles: `VERIFY_REVISE=0`, `VERIFY_QUALITY_REPAIR=0`, `VERIFY_SHOTS=0`, `VERIFY_ABLATION=0`.

---

## What we keep as-is

- Full analysis depth (quality of first reasoning)
- Backend-owned hunks, coverage, line numbers, `+`/`−`, verbatim + stitch checks
- Verifier trust model: backend confirms `repro.cjs` on BASE/HEAD before ablation
- Ablation as measurement; revise as correction from facts, not “guess again”
- No paid Bob during routine verification of unrelated tasks

---

## Risks

- **Q1:** Must not overwrite a valid walkthrough with a broken revise — keep script’s
  “save only if validate passes” rule.
- **Q2:** Only critical codes; soft warnings stay warnings so resume doesn’t churn style.
- **Q3:** Any write grant to Bob must be scoped to the output path.
- **Q4:** Critic prompt must be strong enough to catch real unsupported claims (plan’s
  bar: would have flagged #10943 s3/s5-type issues).
- **Q6:** Bias to “still verify” when unsure — quality of evidence > skipping.

---

## Done when

- [ ] Contradicted steps are revised in the live pipeline, not only via CLI (Q1)
- [ ] Critical quality codes get one automatic resume repair (Q2)
- [ ] A known large-output case is recoverable without discarding Bob’s analysis (Q3)
- [ ] Non-visual path has a defined quality mechanism (critic) or an explicit honest gap (Q4)
- [ ] #8340 (and similar) state clearly why there are no screenshots (Q5)
- [ ] Screenshot verification isn’t implied for non-screenshotable changes (Q6)
- [ ] Tests + lint + web build green; paid runs only with go-ahead + cost-log row
