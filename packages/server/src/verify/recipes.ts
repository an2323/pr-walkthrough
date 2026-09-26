/**
 * recipes.ts — how to install and start a repository's app for the screenshot
 * verifier (ST6e). The verifier only runs for repos listed here: starting an
 * app means running that repository's own code (install scripts, dev server),
 * so the allowlist is the first safety line, not a convenience.
 */

export interface AppRecipe {
  /** "owner/repo" */
  repo: string;
  /** Skip install when this path (relative to the worktree) exists. */
  installedMarker: string;
  install: { cmd: string; args: string[] };
  /** Dev server on `port`, bound to 127.0.0.1 only. */
  start(port: number): { cmd: string; args: string[]; env: Record<string, string> };
  /** Viewport the screenshots are taken at. */
  viewport: { width: number; height: number };
  /** App-specific tips for Bob: first-run dialogs, where things live, selectors to trust. */
  hints: string;
}

const RECIPES: AppRecipe[] = [
  {
    repo: "excalidraw/excalidraw",
    installedMarker: "node_modules/vite",
    install: { cmd: "yarn", args: ["install", "--frozen-lockfile", "--non-interactive", "--network-timeout", "600000"] },
    start: (port) => ({
      cmd: "yarn",
      args: ["--cwd", "excalidraw-app", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      env: { VITE_APP_PORT: String(port), BROWSER: "none" },
    }),
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
    ].join("\n"),
  },
];

export function recipeFor(owner: string, repo: string): AppRecipe | undefined {
  return RECIPES.find((r) => r.repo === `${owner}/${repo}`);
}
