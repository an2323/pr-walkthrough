# Screenshot recipe — excalidraw/excalidraw#10295

1. Worktrees at BASE `95ddc66` and HEAD `67926be`.
2. `yarn install` + `VITE_APP_PORT=<port> yarn --cwd excalidraw-app vite`.
3. Dismiss `.excalidraw-modal-container`.
4. Click `label[title="Library"]`; undock if `button.sidebar__dock.selected`.
5. Click `button.main-menu-trigger`.
6. Screenshot 1280×800.

Before: sidebar stays open with the menu (bug).
After: opening the menu closes the undocked sidebar (fix).

Automated by: `pnpm --filter @pr-walkthrough/server bob:verify-shots excalidraw/excalidraw#10295`
(or `verify-shots` for the $0 Playwright fallback path, when present).

## Per-symptom evidence (step s1)

The Bob verifier (`pr-verifier` in `bob-verifier.ts`) attaches one screenshot per
symptom when useful, via `visual.symptoms.items[].src` (paths relative to this
folder). After a confirmed `repro.cjs`, Bob may write `.walkthrough/verify/symptoms.json`
plus optional `symptom-N.cjs` scripts; the backend runs those against BASE only and
skips items that are not visible in a still (or already covered by `before.png`).

Hand crops / one-off scripts below are fallbacks for demo polish — not required once
a paid `bob:verify-shots … --apply` has produced the files:

| File | Scenario |
|---|---|
| `symptom-toolbar-before.png` | Desktop BEFORE only — left half of the old BA collage (toolbar above sidebar). Rebuild: `extract-toolbar-before.ts` |
| `symptom-menu-under-sidebar-mobile.png` | Mobile 390×844 BASE — sidebar covering the open main menu (raw, no overlay labels; caption is on the card) |

**Paid re-verify needs an explicit go-ahead** (Bobcoins). Until then, keep the hand
assets committed for the static demo.
