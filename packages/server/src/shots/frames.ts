/**
 * frames.ts — what kind of picture a screenshot is.
 *
 * A phone frame (a 390-px viewport, captured at 1×–3×) gets no rectangles or labels drawn on it: the
 * menu IS the whole screen, so a box marks nothing, and text on a narrow picture always covers
 * something. Its words go in the viewer's caption. A desktop frame gets boxes on whole elements
 * and short labels in empty space (shots/annotate.ts).
 */

/** Widest frame still treated as a phone: 390 CSS px at 2× is 780; the smallest desktop viewport we use is 1024. */
export const PHONE_MAX_WIDTH = 800;

export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function isPhoneFrame(png: Buffer): boolean {
  const d = pngDimensions(png);
  return !!d && d.width <= PHONE_MAX_WIDTH;
}

/**
 * The scenario whose frames become the MAIN before/after pair: among those whose frames differ, the
 * widest (desktop) one — the change shown in its whole context — and only a phone-only change falls
 * back to a phone pair. Ties keep the analysis's own order.
 */
export function pickMainIndex(candidates: { visible: boolean; width: number }[]): number {
  let best = -1;
  candidates.forEach((c, i) => {
    if (c.visible && (best < 0 || c.width > candidates[best].width)) best = i;
  });
  return best;
}
