/**
 * The auto-calibrated skill curve fit. Pure: no database, no SQL — kept on its
 * own so it can be tested (and reasoned about) without the rest of scoreSql.
 */

const FULL_BASE = 1_000_000;

export const CURVE_STEPS = 100; // 0.1★ slices, capped at 10★+
export interface CurveBucket {
  q: number; // slice (star_rating * 10, capped)
  value: number; // the slice's median (carried over when the slice lacks one)
  /** median of the slice's own bests, before the fit. null under 5 bests. */
  raw: number | null;
  samples: number; // number of bests in the slice
}

/**
 * Turns raw bests per 0.1★ slice into the retained prediction of every slice.
 * Shared by the live curve and the time machine (which re-fits it on the
 * bests of a past date) — two implementations would drift apart.
 *
 * The value of a slice is the raw median of its own bests when it has at
 * least 5 of them — nothing is forced onto it, the curve follows the scores
 * wherever they go. No 1M cap (modded bests). Slices without enough bests
 * inherit from the last one that has a median (and from the first for those
 * below the data).
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
  const rawByQ = new Map(sampled.map((p) => [p.q, p.value]));

  let prev = sampled.length ? sampled[0].value : FULL_BASE;
  const buckets: CurveBucket[] = [];
  for (let q = 0; q <= CURVE_STEPS; q++) {
    prev = rawByQ.get(q) ?? prev;
    buckets.push({
      q,
      value: Math.round(prev),
      raw: rawByQ.get(q) ?? null,
      samples: byQ.get(q)?.length ?? 0,
    });
  }
  return buckets;
}
