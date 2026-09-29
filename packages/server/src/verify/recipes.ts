/**
 * recipes.ts — how to install and start a repository's app for the screenshot
 * verifier (ST6e). The verifier only runs for repos listed here: starting an
 * app means running that repository's own code (install scripts, dev server),
 * so the allowlist is the first safety line, not a convenience.
 */

export interface AppRecipe {
  /** "owner/repo" */
  repo: string;
  /**
   * Written by the package manager at the very END of a successful install —
   * its presence means "finished", not just "started" (relative to the worktree).
   */
  installedMarker: string;
  /** Lockfile; worktrees with the same one can share an install. */
  lockfile: string;
  install: { cmd: string; args: string[] };
  /** Dev server on `port`, bound to 127.0.0.1 only. */
  start(port: number): { cmd: string; args: string[]; env: Record<string, string> };
  /** A selector that means "the app has rendered" (used by the backend warm-up before Bob starts). */
  readySelector?: string;
  /** Viewport the screenshots are taken at. */
  viewport: { width: number; height: number };
  /** App-specific tips for Bob: first-run dialogs, where things live, selectors to trust. */
  hints: string;
}

const RECIPES: AppRecipe[] = [
  {
    repo: "excalidraw/excalidraw",
    installedMarker: "node_modules/.yarn-integrity",
    lockfile: "yarn.lock",
    install: { cmd: "yarn", args: ["install", "--frozen-lockfile", "--prefer-offline", "--non-interactive", "--network-timeout", "600000"] },
    start: (port) => ({
      cmd: "yarn",
      args: ["--cwd", "excalidraw-app", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      // ESLINT off: the dev server's checker plugin would otherwise lint the whole monorepo
      // (twice, BASE and HEAD, on the same two cores) before the app is usable.
      env: { VITE_APP_PORT: String(port), BROWSER: "none", VITE_APP_ENABLE_ESLINT: "false" },
    }),
    readySelector: ".excalidraw",
    viewport: { width: 1280, height: 800 },
    hints: [
      "- The editor is a single page; wait for `.excalidraw` and then ~1 s before interacting.",
      "- A first-run welcome screen / modal may cover the canvas: remove `.excalidraw-modal-container`",
      "  elements, or press Escape.",
      "- Toolbar buttons and menu items usually have stable `title`/`aria-label` attributes and",
      "  `data-testid`s; prefer those over text. Search the HEAD source for the component the PR",
      "  touches to find its class names.",
      "- The mobile layout kicks in below ~730 px width (use a 390×844 viewport for it).",
      "- Drawing: select a tool, then `page.mouse` down/move/up on the canvas.",
      "- Panels (verified on this app): open the Library sidebar by clicking `.sidebar-trigger__label-element`",
      "  (the visible trigger is a label; clicking the inner `.default-sidebar-trigger` div does nothing).",
      "  The sidebar element is `.sidebar` (class `Island sidebar default-sidebar`). It can be docked beside",
      "  the canvas or floating over it; `button.sidebar__dock` toggles that (`.selected` = docked).",
      "- The main menu opens with `button.main-menu-trigger` (the top-left menu).",
      "- The top-right group is `.excalidraw-ui-top-right`; there is no `.App-top-bar` element in this build.",
      "- A locator that finds nothing is the usual failure here: log what was found before deciding anything.",
    ].join("\n"),
  },
];

export function recipeFor(owner: string, repo: string): AppRecipe | undefined {
  return RECIPES.find((r) => r.repo === `${owner}/${repo}`);
}
