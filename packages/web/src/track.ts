/**
 * track.ts — one-line click counter on top of the GoatCounter script in index.html.
 * The script counts page views by itself (every PR has its own URL); this adds named
 * clicks. Silent no-op when the script is absent (dev, ad blockers, offline).
 */

type GoatCounter = { count?: (vars: { path: string; title?: string; event?: boolean }) => void };

export function track(name: string): void {
  try {
    (window as unknown as { goatcounter?: GoatCounter }).goatcounter?.count?.({ path: name, event: true });
  } catch {
    // counting must never break the page
  }
}
