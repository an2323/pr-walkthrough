/**
 * staticMode.ts — URL helpers for static demo vs live API.
 *
 * - `VITE_STATIC=1`: public demo; walkthroughs/audio under `/data/` (no backend).
 * - Otherwise API paths go to same origin (dev proxy) or `VITE_API_BASE` (prod
 *   frontend on Vercel talking to Railway/Hetzner).
 */

export const STATIC = import.meta.env.VITE_STATIC === '1';

/** Origin of the API (no trailing slash). Empty = same origin / Vite proxy. */
export const API_BASE = String(import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

/** Prefix an absolute API path (`/api/...` or `/data/...`) with API_BASE when set. */
export function apiUrl(path: string): string {
  if (STATIC || !API_BASE) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

export function walkthroughUrl(owner: string, repo: string, number: number): string {
  if (STATIC) return `/data/walkthroughs/${owner}/${repo}/${number}.json`;
  // `?rehearsal=1` on the page: show the last $0 rehearsal's result instead of the real walkthrough.
  const rehearsal = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('rehearsal');
  return apiUrl(`/api/walkthroughs/${owner}/${repo}/${number}${rehearsal ? '?rehearsal=1' : ''}`);
}

export function audioUrl(owner: string, repo: string, number: number, stepId: string, sentence: number): string {
  return STATIC
    ? `/data/audio/${owner}/${repo}/${number}/${stepId}/${sentence}.mp3`
    : apiUrl(`/api/audio/${owner}/${repo}/${number}/${stepId}/${sentence}.mp3`);
}

/** Recorded run as raw ProgressEvent ndjson (static build only; the server replays it over SSE otherwise). */
export function recordingUrl(owner: string, repo: string, number: number): string {
  return `/data/events/${owner}/${repo}/${number}.ndjson`;
}

/** Before/after screenshot under data/shots (served as /data/... in both static and API builds). */
export function shotUrl(owner: string, repo: string, number: number, src: string): string {
  const safe = src.replace(/^\/+/, '').replace(/\.\./g, '');
  const path = `/data/shots/${owner}/${repo}/${number}/${safe}`;
  return STATIC ? path : apiUrl(path);
}
