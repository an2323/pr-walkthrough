/**
 * landingData.ts — the fixed content of the landing page: the PR the hero quotes, the Excalidraw PR list link,
 * and the suggested PRs. The hero step is copied from the real #10295 walkthrough (step "cause"), so what the
 * page shows is what the viewer shows; the frames under it are that same run's before/after pair.
 */

/** The PR the hero and the proof band are about. Its frames are read through shotUrl(), like any card. */
export const HERO_PR = { owner: 'excalidraw', repo: 'excalidraw', number: 10295 } as const;

/** Merged Excalidraw PRs whose title says "fix" and mentions something you can see — a good first paste. */
export const EXCALIDRAW_UI_FIXES_URL =
  'https://github.com/excalidraw/excalidraw/pulls?q=' +
  encodeURIComponent('is:pr is:merged in:title fix (menu OR sidebar OR button OR popup OR dialog OR toolbar OR panel OR picker OR overflow OR tooltip) sort:created-desc');

export interface SuggestedPr {
  url: string;
  label: string;
  /** "+30 −7" */
  size: string;
}

/** Small, recent, visible UI fixes in Excalidraw — each one checked to start its app (see docs/cost-log.md). */
export const SUGGESTED_PRS: SuggestedPr[] = [];

export const HERO_STEP = {
  repoLine: 'excalidraw/excalidraw #10295',
  prTitle: 'fix: close floating sidebar on main menu open',
  kicker: 'Problem',
  headline: 'Sidebar z-index sits below the top bar',
  say: "The sidebar's stacking number was 80 while the top toolbar was 100, so toolbar buttons painted over the panel.",
  layers: {
    before: [
      { name: 'Top toolbar buttons', z: 100, tone: 'bad' as const },
      { name: 'Sidebar panel', z: 80, tone: 'plain' as const },
    ],
    after: [
      { name: 'Sidebar panel', z: 120, tone: 'hl' as const },
      { name: 'Top toolbar buttons', z: 100, tone: 'plain' as const },
    ],
  },
  ask: 'Should context menu or styles popup stay above the sidebar?',
  file: 'packages/excalidraw/css/styles.scss',
  lines: [
    { n: 15, text: '  --zIndex-ui-bottom: 60;', focus: false },
    { n: 16, text: '  --zIndex-ui-library: 80;', focus: true, note: 'Used by the sidebar; lower than the top bar.' },
    { n: 17, text: '  --zIndex-ui-context-menu: 90;', focus: false },
    { n: 18, text: '  --zIndex-ui-styles-popup: 100;', focus: false },
    { n: 19, text: '  --zIndex-ui-top: 100;', focus: true, note: 'Used by `.App-top-bar`; higher than the sidebar at 80.' },
  ],
} as const;

export const PROOF_CAPTIONS = {
  before: 'Menu opened — the sidebar is still open',
  after: 'Menu opened — the sidebar closed by itself',
} as const;
