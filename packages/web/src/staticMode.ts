/**
 * staticMode.ts — the public demo build (ST6f, `VITE_STATIC=1`) has no backend.
 *
 * Walkthroughs, narration and recorded runs are plain files under /data/, written by
 * `pnpm --filter @pr-walkthrough/server export-static` after the Vite build. Live
 * analysis and GitHub posting are off in this build.
 */

export const STATIC = import.meta.env.VITE_STATIC === '1';

export function walkthroughUrl(owner: string, repo: string, number: number): string {
  return STATIC
    ? `/data/walkthroughs/${owner}/${repo}/${number}.json`
    : `/api/walkthroughs/${owner}/${repo}/${number}`;
}

export function audioUrl(owner: string, repo: string, number: number, stepId: string, sentence: number): string {
  return STATIC
    ? `/data/audio/${owner}/${repo}/${number}/${stepId}/${sentence}.mp3`
    : `/api/audio/${owner}/${repo}/${number}/${stepId}/${sentence}.mp3`;
}

/** Recorded run as raw ProgressEvent ndjson (static build only; the server replays it over SSE otherwise). */
export function recordingUrl(owner: string, repo: string, number: number): string {
  return `/data/events/${owner}/${repo}/${number}.ndjson`;
}
