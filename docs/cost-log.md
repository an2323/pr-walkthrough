# Bobcoin cost log

One row per paid Bob Shell run. Raw output for each run is in `data/runs/<stamp>-<mode>/` (gitignored).

| Date (UTC) | Run | PR | Mode | Max cost | Duration | Coins before | Coins after | JSON parsed | Valid | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-26 11:19 | smoke | — | pr-walkthrough | 1 | 4 s | $50 key | — | yes | — | `session_costs` 0.0092, 0 tool calls |
| 2026-09-26 11:20 | readonly | — | pr-walkthrough | 1 | 5 s | — | — | yes | — | `session_costs` 0.0093; Bob refused to write, file absent |
| 2026-09-26 11:20 | full | excalidraw#10295 | pr-walkthrough | 5 | 174 s | — | — | yes | yes* | `session_costs` 3.129, 43 tool calls, 10 steps, 3 questions, 5/5 hunks. *3 blocks cited `.walkthrough/base/…` paths — valid after backend normalisation; prompt fixed |
| 2026-09-26 13:41 | tts:pregen excalidraw/excalidraw#10295 | generated=35 cached=0 chars=3605 elapsed=47.4s |
| 2026-09-26 13:41 | tts:pregen excalidraw/excalidraw#10295 | generated=0 cached=35 chars=3605 elapsed=0.0s |
| 2026-09-27 09:36 | tts:pregen excalidraw/excalidraw#10295 steps=s1,s2 | generated=7 cached=0 chars=637 elapsed=9.5s |
| 2026-09-27 10:33 | tts:pregen excalidraw/excalidraw#10295 | generated=17 cached=7 chars=2267 elapsed=22.3s |
