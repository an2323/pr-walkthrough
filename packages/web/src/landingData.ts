/** landingData.ts — the fixed content of the landing page: the Excalidraw PR list link and the suggested PRs. */

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

/** Small, recent, visible UI fixes in Excalidraw. Each was checked with scripts/warm-app.ts (both commits install and the app loads, 2026-09-30); that does not prove a run reproduces the bug. */
export const SUGGESTED_PRS: SuggestedPr[] = [
  { url: 'https://github.com/excalidraw/excalidraw/pull/11680', label: '#11680 scroll-back button', size: '+60 −53' },
  { url: 'https://github.com/excalidraw/excalidraw/pull/11286', label: '#11286 duplicate lasso item', size: '+30 −7' },
  { url: 'https://github.com/excalidraw/excalidraw/pull/10880', label: '#10880 left-menu spacing', size: '+1 −1' },
];

/** Walkthroughs shown first under "Already analysed", in this order; the rest follow, newest first. */
export const PINNED_WALKTHROUGHS: string[] = ['excalidraw/excalidraw#10295', 'excalidraw/excalidraw#12053'];
