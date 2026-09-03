/**
 * Pure geometry of the "Accuracy by difficulty" scatter: extent, gridline
 * steps and visibility. No DOM, no React: extracted so the math is unit
 * tested (the zoom edge-pile bug lived exactly here, invisible to the eye
 * until someone zoomed near the right edge).
 */

/** the axis floor: everything below (rare) is drawn on the floor line */
export const ACC_FLOOR = 0.55;

export interface Zoom {
  x0: number;
  x1: number;
  a0: number;
  a1: number;
}

/**
 * A 1/2/5 x 10^k step giving at most `target` gridlines over `span`. The
 * loved pool holds aspire maps in the hundreds of stars, a fixed 1-star
 * step would paint a wall of labels.
 */
export const niceStep = (span: number, target: number, min: number): number => {
  const raw = Math.max(span, 1e-9) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (pow * m >= raw) return Math.max(min, pow * m);
  return Math.max(min, pow * 10);
};

/**
 * Full x-axis extent for a set of star ratings: the highest map still
 * PROPORTIONATE to the bulk (within 3x the 99.5th percentile), rounded up
 * to the half star. Only the out-of-scale tail (aspire maps in the
 * hundreds of stars) is excluded and piles on the edge, so the All pool
 * keeps the same axis as Ranked instead of collapsing to the percentile
 * the moment one aspire map enters the cloud.
 */
export function scatterExtent(srs: number[]): number {
  if (srs.length === 0) return 10;
  const sorted = [...srs].sort((a, b) => a - b);
  const cap = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))];
  let lim = cap;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] <= cap * 3) {
      lim = sorted[i];
      break;
    }
  }
  return Math.max(1, Math.ceil(lim * 2) / 2);
}

/**
 * Visibility of a point in the current view. Unzoomed, everything is
 * visible: the drawing clamps out-of-extent outliers onto the right edge
 * and the accuracy floor, so nothing disappears. Zoomed, the same pile
 * semantics apply to every window EDGE that still touches the extent:
 * a window whose right side sits on the extent keeps the maps piled
 * there (they used to be silently dropped, and since zoom is clamped to
 * the extent they could never be brought back into any window), and a
 * window resting on the accuracy floor keeps the sub-floor scores.
 * Interior edges cut normally. The left edge (0 stars) and the top
 * (100%) never clamp anything, no special case needed.
 */
export function makeInView(
  zoom: Zoom | null,
  extent: number,
  floor: number = ACC_FLOOR
): (sr: number, acc: number) => boolean {
  if (zoom == null) return () => true;
  const atRight = zoom.x1 >= extent - 1e-9;
  const atFloor = zoom.a0 <= floor + 1e-9;
  return (sr, acc) =>
    sr >= zoom.x0 &&
    (atRight || sr <= zoom.x1) &&
    acc <= zoom.a1 &&
    (atFloor || acc >= zoom.a0);
}
