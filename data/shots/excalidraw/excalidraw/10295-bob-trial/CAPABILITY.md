# Bob verifier spike — excalidraw/excalidraw#10295

Date: 2026-09-26T20:38:50Z  
Cost: **$0.389** (max $5) · Duration: **79s** · Tools: 17 execute/write/read · Subagents: 0  
Task id: `84e79ec96f32c9d274be6ec6a432fe86`  
Raw run: `data/runs/bob-verify-2026-09-26T20-37-32/` (gitignored)

## Verdict

**Yes — for a known Excalidraw PR with an explicit RECIPE, Bob can drive the verifier step.**

Bob (mode `pr-verifier`: read + edit + execute):

1. Started Vite for BASE (`:3020`) and HEAD (`:3021`) in the cached worktrees.
2. Wrote a temporary Playwright script (`tmp-screenshot.js`), ran it via `node` + our server's Playwright.
3. Reproduced Library → undock → main menu; measured `.dropdown-menu` / `.sidebar` via `getBoundingClientRect`.
4. Wrote `before.png`, `after.png`, `result.json` under this trial folder only.
5. Killed the Vite processes and deleted temp scripts.

Our harness then ran `annotateShot` → `before-annotated.png` / `after-annotated.png`.

Hand-tuned demo assets under `data/shots/.../10295/` were **not** modified.

## What the images show

| Side | Content | Highlights |
|---|---|---|
| Before (BASE) | Menu open + library sidebar still open (bug) | DOM-measured menu + sidebar — usable |
| After (HEAD) | Menu open, sidebar gone (`sidebarRect: null`) | Menu measured; “closed” box is a fallback right-edge region |

Quality is close to the hand-tuned demo for **before**. **After** “Sidebar closed by itself” is a guessed empty region (honest limitation when the element is gone).

Raw PNGs happened to match the previous demo raw files byte-for-byte (same UI + viewport → deterministic PNG). They were still produced by Bob’s Playwright run against live Vite, not by copying the demo dir (see NDJSON tool trace).

## Railway / “paste any PR”?

**Not proven.** This spike had:

- Pre-cloned Excalidraw worktrees at known SHAs  
- A human RECIPE + selectors in the prompt  
- Allowlisted ports and Playwright already installed in *our* monorepo  

For a public “any PR” Railway demo you still need: repo allowlist / size limits, per-ecosystem start recipes (or Bob inventing them reliably), cost caps, and cleanup. The spike shows the **verifier stage is plausible** for Excalidraw-like apps once those guards exist — not that arbitrary GitHub PRs work today.

## How to re-run

```bash
pnpm --filter @pr-walkthrough/server bob:verify-shots
# optional: MAX_COST=5
```

Logged in `docs/cost-log-stage2.md` as mode `pr-verifier`.
