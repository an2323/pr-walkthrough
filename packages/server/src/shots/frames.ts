/**
 * frames.ts — what kind of picture a screenshot is.
 *
 * A phone frame (a 390-px viewport, captured at 1×–3×) gets no rectangles or labels drawn on it: the
 * menu IS the whole screen, so a box marks nothing, and text on a narrow picture always covers
 * something. Its words go in the viewer's caption. A desktop frame gets boxes on whole elements
 * and short labels in empty space (shots/annotate.ts).
 */

/**
 * A phone frame is a tall portrait capture (390×844 at 1×, 780×1688 at 2×, 375×667 …): the pixel
 * width alone cannot tell a 2× phone (780) from a 1× tablet (768×1024), the aspect ratio can. A tablet
 * is drawn on like a desktop frame — a control in it can be a small part of the picture.
 */
export const PHONE_MIN_ASPECT = 1.7;
/** Any capture this narrow is a phone at 1×, whatever its height. */
export const PHONE_MAX_WIDTH_1X = 500;

export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function isPhoneSize(width: number, height: number): boolean {
  return width <= PHONE_MAX_WIDTH_1X || height / width >= PHONE_MIN_ASPECT;
}

export function isPhoneFrame(png: Buffer): boolean {
  const d = pngDimensions(png);
  return !!d && isPhoneSize(d.width, d.height);
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
