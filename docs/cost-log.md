# Bobcoin cost log

One row per paid Bob Shell run. Raw output for each run is in `data/runs/<stamp>-<mode>/` (gitignored).

| Date (UTC) | Run | PR | Mode | Max cost | Duration | Coins before | Coins after | JSON parsed | Valid | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-26 11:19 | smoke | — | pr-walkthrough | 1 | 4 s | $50 key | — | yes | — | `session_costs` 0.0092, 0 tool calls |
| 2026-09-26 11:20 | readonly | — | pr-walkthrough | 1 | 5 s | — | — | yes | — | `session_costs` 0.0093; Bob refused to write, file absent |
| 2026-09-26 11:20 | full | excalidraw#10295 | pr-walkthrough | 5 | 174 s | — | — | yes | yes* | `session_costs` 3.129, 43 tool calls, 10 steps, 3 questions, 5/5 hunks. *3 blocks cited `.walkthrough/base/…` paths — valid after backend normalisation; prompt fixed |
