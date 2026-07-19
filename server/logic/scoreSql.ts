/**
 * Shared SQL expression builders (required aliases: b = beatmaps, s = best
 * score, u = beatmap_user) + the auto-calibrated skill curve.
 */
import { getDb } from "../db/db.js";

// ---------- Shared SQL expressions (required aliases: b = beatmaps, s = best) ----------

export const FULL_BASE = 1_000_000;
export const N_OBJ =
  "(COALESCE(b.count_circles,0) + COALESCE(b.count_sliders,0) + COALESCE(b.count_spinners,0))";
// Max classic of a map (SS NoMod): n_objects² × 32.57 + 100000 (lazer formula)
const CLASSIC_MAX = `CASE WHEN ${N_OBJ} > 0 THEN CAST(ROUND(32.57 * ${N_OBJ} * ${N_OBJ} + 100000) AS INTEGER) ELSE ${FULL_BASE} END`;

/** standardised -> classic conversion (proportional to the map's max). */
function classicFromStd(stdExpr: string): string {
  return `CAST(ROUND(${CLASSIC_MAX} * (${stdExpr}) / ${FULL_BASE}.0) AS INTEGER)`;
}

// Witherscore (proposal ppy/osu#38224):
//   scaled = min(std/1M, (std/1M)^1.62)
//   wither = scaled × (n_objects² × 36.49 + n_objects × 2095) + std × 0.1
// Monotone in standardised on a given map => same best as lazer.
export function witherSql(stdExpr: string, nExpr: string = N_OBJ): string {
  const x = `(CAST(${stdExpr} AS REAL) / ${FULL_BASE}.0)`;
  return `CAST(ROUND(MIN(${x}, pow(${x}, 1.62)) * (36.49 * ${nExpr} * ${nExpr} + 2095.0 * ${nExpr}) + ${stdExpr} * 0.1) AS INTEGER)`;
}

/**
 * Realistic missing of a map: skill-curve prediction minus the current best,
 * in the requested metric (0 = nothing to grab given MY level).
 */
export function missingExprs(mode: "classic" | "lazer"): {
  predExpr: string;
  missingSql: string;
} {
  const pred =
    mode === "classic"
      ? classicFromStd(skillCurveCase())
      : `(${skillCurveCase()})`;
  const best =
    mode === "classic"
      ? "COALESCE(s.classic_total_score, s.total_score, 0)"
      : "COALESCE(s.total_score, 0)";
  return { predExpr: pred, missingSql: `MAX(0, ${pred} - ${best})` };
}

/** Realistic missing in wither (standardised fallback if object count unknown). */
export function witherMissingSql(): string {
  const pred = `(${skillCurveCase()})`;
  return `CASE WHEN ${N_OBJ} > 0
    THEN MAX(0, ${witherSql(pred)} - ${witherSql("COALESCE(s.total_score, 0)")})
    ELSE MAX(0, ${pred} - COALESCE(s.total_score, 0)) END`;
}

/**
 * Auto-calibrated skill curve: for each 0.1★ slice, the MEDIAN of my bests
 * (standardised) = the "realistic" score I can post at that difficulty,
 * adjusted into a decreasing curve by weighted isotonic regression (PAVA).
 * Gaps (< 5 bests) filled by carry-over. 10 min cache.
 * Used for the "realistic gain" = what I can still grab on a map given MY
 * level, not the theoretical max.
 */
export const CURVE_STEPS = 100; // 0.1★ slices, capped at 10★+
interface CurveBucket {
  q: number; // slice (star_rating * 10, capped)
  value: number; // retained prediction (after carry-over + monotonicity)
  samples: number; // number of bests in the slice
}
let curveCache: { until: number; caseSql: string; buckets: CurveBucket[] } | null =
  null;
export function computeSkillCurve(): { caseSql: string; buckets: CurveBucket[] } {
  if (curveCache && Date.now() < curveCache.until) return curveCache;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT MIN(CAST(b.star_rating * 10 AS INTEGER), ${CURVE_STEPS}) AS q, s.total_score AS ts
       FROM beatmap_user u
       JOIN scores s ON s.id = u.best_lazer_score_id
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE b.ruleset = 0 AND b.star_rating IS NOT NULL`
    )
    .all() as { q: number; ts: number }[];
  const byQ = new Map<number, number[]>();
  for (const r of rows) {
    const arr = byQ.get(r.q) ?? [];
    arr.push(r.ts);
    byQ.set(r.q, arr);
  }
  // Raw medians of the sufficiently populated slices (>= 5 bests), then
  // DECREASING isotonic regression by PAVA, weighted by the number of bests:
  // slices conflicting with the decrease are averaged together instead of
  // being crushed by the previous one — a small easy slice with old scores is
  // pulled up by its thousands of neighbors, and artificial plateaus
  // disappear. No 1M cap (modded bests).
  const sampled: { q: number; value: number; weight: number }[] = [];
  for (let q = 0; q <= CURVE_STEPS; q++) {
    const arr = byQ.get(q);
    if (arr && arr.length >= 5) {
      arr.sort((a, b) => a - b);
      sampled.push({
        q,
        value: arr[Math.floor(arr.length / 2)],
        weight: arr.length,
      });
    }
  }
  // PAVA (pool adjacent violators) for a non-increasing sequence
  const blocks: { value: number; weight: number; count: number }[] = [];
  for (const p of sampled) {
    let cur = { value: p.value, weight: p.weight, count: 1 };
    while (blocks.length && blocks[blocks.length - 1].value < cur.value) {
      const prevB = blocks.pop()!;
      cur = {
        value:
          (prevB.value * prevB.weight + cur.value * cur.weight) /
          (prevB.weight + cur.weight),
        weight: prevB.weight + cur.weight,
        count: prevB.count + cur.count,
      };
    }
    blocks.push(cur);
  }
  const fitted: number[] = [];
  for (const b of blocks)
    for (let k = 0; k < b.count; k++) fitted.push(b.value);
  const fittedByQ = new Map(sampled.map((p, i) => [p.q, fitted[i]]));

  // Slices without enough bests: inherit from the last fitted slice
  // (and from the first one for those below the data).
  let prev = fitted[0] ?? FULL_BASE;
  const buckets: CurveBucket[] = [];
  for (let q = 0; q <= CURVE_STEPS; q++) {
    prev = fittedByQ.get(q) ?? prev;
    buckets.push({
      q,
      value: Math.round(prev),
      samples: byQ.get(q)?.length ?? 0,
    });
  }
  const parts = buckets.map((b) => `WHEN ${b.q} THEN ${b.value}`);
  const caseSql = `CASE MIN(CAST(b.star_rating * 10 AS INTEGER), ${CURVE_STEPS}) ${parts.join(" ")} ELSE ${buckets[buckets.length - 1].value} END`;
  curveCache = { until: Date.now() + 10 * 60_000, caseSql, buckets };
  return curveCache;
}
export function skillCurveCase(): string {
  return computeSkillCurve().caseSql;
}
