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
