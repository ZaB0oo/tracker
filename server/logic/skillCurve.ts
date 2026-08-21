/**
 * The auto-calibrated skill curve fit. Pure: no database, no SQL — kept on its
 * own so it can be tested (and reasoned about) without the rest of scoreSql.
 */

const FULL_BASE = 1_000_000;

export const CURVE_STEPS = 100; // 0.1★ slices, capped at 10★+
export interface CurveBucket {
  q: number; // slice (star_rating * 10, capped)
  value: number; // retained prediction (after carry-over + monotonicity)
  /** median of the slice's own bests, before the fit. null under 5 bests. */
  raw: number | null;
  samples: number; // number of bests in the slice
}

/**
 * Turns raw bests per 0.1★ slice into the retained prediction of every slice.
 * Shared by the live curve and the time machine (which re-fits it on the
 * bests of a past date) — two implementations would drift apart.
 *
 * Raw medians of the sufficiently populated slices (>= 5 bests), then a
 * running maximum from the hard end: a slice's prediction is its own median
 * or the best median of any harder slice, whichever is higher — what you
 * reach on hard maps is reachable on easy ones, and a slice is never
 * predicted below what its own scores show. No 1M cap (modded bests). Slices
 * without enough bests inherit from the last fitted one (and from the first
 * for those below the data).
 */
export function fitSkillCurve(byQ: Map<number, number[]>): CurveBucket[] {
  const sampled: { q: number; value: number }[] = [];
  for (let q = 0; q <= CURVE_STEPS; q++) {
    const arr = byQ.get(q);
    if (arr && arr.length >= 5) {
      arr.sort((a, b) => a - b);
      sampled.push({ q, value: arr[Math.floor(arr.length / 2)] });
    }
  }
  // Running max from the hard end. The raw median is kept aside so the UI can
  // draw both: the gap between the two is where score is left to grind.
  const fittedByQ = new Map<number, number>();
  let runMax = -Infinity;
  for (let i = sampled.length - 1; i >= 0; i--) {
    runMax = Math.max(runMax, sampled[i].value);
    fittedByQ.set(sampled[i].q, runMax);
  }
  const rawByQ = new Map(sampled.map((p) => [p.q, p.value]));

  let prev = sampled.length ? fittedByQ.get(sampled[0].q)! : FULL_BASE;
  const buckets: CurveBucket[] = [];
  for (let q = 0; q <= CURVE_STEPS; q++) {
    prev = fittedByQ.get(q) ?? prev;
    buckets.push({
      q,
      value: Math.round(prev),
      raw: rawByQ.get(q) ?? null,
      samples: byQ.get(q)?.length ?? 0,
    });
  }
  return buckets;
}
