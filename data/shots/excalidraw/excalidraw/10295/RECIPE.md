# Screenshot recipe — excalidraw/excalidraw#10295

1. Worktrees at BASE `95ddc66` and HEAD `67926be`.
2. `yarn install` + `VITE_APP_PORT=<port> yarn --cwd excalidraw-app vite`.
3. Dismiss `.excalidraw-modal-container`.
4. Click `label[title="Library"]`; undock if `button.sidebar__dock.selected`.
5. Click `button.main-menu-trigger`.
6. Screenshot 1280×800.

Before: sidebar stays open with the menu (bug).
After: opening the menu closes the undocked sidebar (fix).

Automated by: `pnpm --filter @pr-walkthrough/server verify-shots excalidraw/excalidraw#10295`
