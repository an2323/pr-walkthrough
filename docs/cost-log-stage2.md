# Bob Shell cost log — Stage 2: quality iteration

Hard cap for this stage: **$20**, tracked separately from the ST5a
spike in `docs/cost-log.md`. Every row's "Actual cost" is summed and checked
*before* each run starts (against the run's own `--max-cost`, the worst case) —
a run that could push the total over the cap is refused rather than attempted.
Raw output for each run is in `data/runs/<stamp>/` (gitignored).

| Date (UTC) | PR | Mode | Max cost | Actual cost | Duration | Tool calls | Subagents | Repairs | Valid | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-26 14:57 | excalidraw/excalidraw#10295 | smoke | 1 | 0.011 | 3s | 0 | 0 | 0 | — |  |
| 2026-09-26 14:59 | excalidraw/excalidraw#10295 | smoke-subagent | 1 | 0.042 | 14s | 2 | 2 | 0 | — | subagent count corrected by hand — logged as 0 before the `tool_name==="spawn_subagent"` detection fix landed |
| 2026-09-26 15:04 | excalidraw/excalidraw#10295 | full | 4 | 2.114 | 208s | 30 | 2 | 0 | yes | logged "—" originally — `findWalkthroughInEvents` had a second bug (concatenated every event field, not just `content`) that hid a valid draft; fixed for $0 by re-extracting from the already-saved raw output, no re-run. Scores 5/5 on `docs/rubrics/10295.md`: correctly names attribute removal as the decision (not "redundant"), correctly marks the type-widening step `minor: true`. Promoted to `data/walkthroughs/excalidraw/excalidraw/10295.json`. |
| 2026-09-26 15:40 | excalidraw/excalidraw#8340 | full | 8 | 1.113 | 245s | 20 | 4 | 0 | no |  |
| 2026-09-26 15:43 | excalidraw/excalidraw#9403 | full | 6 | 0.791 | 393s | 13 | 5 | 0 | no |  |
| 2026-09-26 15:47 | excalidraw/excalidraw#8340 | repair | 1 | 0.000 | 2s | 20 | 4 | 1 | — |  |
| 2026-09-26 15:50 | excalidraw/excalidraw#8340 | repair | 1 | 0.000 | 2s | 20 | 4 | 1 | — |  |
| 2026-09-26 15:58 | excalidraw/excalidraw#8340 | repair | 1 | 0.336 | 137s | 21 | 4 | 1 | yes |  |
