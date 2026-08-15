import { getDb } from "../db/db.js";
import {
  mapWhere,
  scoreWhere,
  type MetricBreakdown,
  type MetricParams,
} from "./metrics.js";
import { parseRulesetParam } from "./rulesets.js";
import { scoresVersion } from "./scoreSql.js";

/**
 * Params come from the HTTP body (preview) or from persisted JSON — never
 * trust them: `ruleset` is interpolated into SQL everywhere below, so a
 * non-numeric value would be an SQL injection. Coerced to 0-3, always.
 */
function sanitized(p: MetricParams): MetricParams {
  return { ...p, ruleset: parseRulesetParam(p.ruleset) };
}

export interface MetricResult {
  count: number;
  total: number; // maps matching the map conditions (denominator for "total" mode)
  step: number;
  milestones: { threshold: number; at: string }[];
  evolution: { period: string; value: number }[] | null;
  /** per-bucket completion in the chosen breakdown dimension */
  byBucket: { bucket: number | string; value: number; total: number }[];
  /** weighted-pp extras (kind "pp" only) */
  pp?: { bonus: number; scoreCount: number };
}

/** Bucket SQL per breakdown dimension (same buckets as the dashboard). */
const BUCKETS: Record<MetricBreakdown, { expr: string; notNull: string }> = {
  sr: { expr: "MIN(CAST(b.star_rating AS INTEGER), 10)", notNull: "b.star_rating" },
  year: { expr: "strftime('%Y', st.ranked_date)", notNull: "st.ranked_date" },
  length: { expr: "MIN(CAST(b.total_length / 60 AS INTEGER), 10)", notNull: "b.total_length" },
  combo: { expr: "MIN(CAST(b.max_combo / 250 AS INTEGER), 10)", notNull: "b.max_combo" },
  ar: { expr: "MIN(CAST(b.ar AS INTEGER), 10)", notNull: "b.ar" },
  od: { expr: "MIN(CAST(b.od AS INTEGER), 10)", notNull: "b.od" },
  cs: { expr: "MIN(CAST(b.cs AS INTEGER), 10)", notNull: "b.cs" },
  hp: { expr: "MIN(CAST(b.hp AS INTEGER), 10)", notNull: "b.hp" },
};

const RANKED_CLASSIC = "COALESCE(s.classic_total_score, s.total_score)";

function periodKey(iso: string, gran: "month" | "day"): string {
  return gran === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

function thresholds(
  points: { at: string; total: number }[],
  step: number
): { threshold: number; at: string }[] {
  const out: { threshold: number; at: string }[] = [];
  let next = step;
  for (const p of points) {
    while (p.total >= next) {
      out.push({ threshold: next, at: p.at });
      next += step;
    }
  }
  return out;
}

/** Downward milestones for descending metrics (crossing 900, 800, … 0 left). */
function thresholdsDesc(
  points: { at: string; total: number }[],
  step: number
): { threshold: number; at: string }[] {
  const out: { threshold: number; at: string }[] = [];
  let next: number | null = null;
  for (const p of points) {
    if (next == null) next = Math.ceil(p.total / step) * step - step;
    while (next >= 0 && p.total <= next) {
      out.push({ threshold: next, at: p.at });
      next -= step;
    }
  }
  return out;
}

function bucketEvolution(
  points: { at: string; total: number }[],
  gran: "month" | "day"
): { period: string; value: number }[] {
  const keys = [...new Set(points.map((p) => periodKey(p.at, gran)))].sort();
  let i = 0;
  let total = 0;
  return keys.map((period) => {
    while (i < points.length && periodKey(points[i].at, gran) <= period)
      total = points[i++].total;
    return { period, value: total };
  });
}

/**
 * Base FROM/JOIN + WHERE for a metric's conditions.
 * `bestOnly` (count metrics): score conditions are evaluated against the
 * map's BEST score only — leaderboard semantics: a lower score matching the
 * conditions does not count when the best does not. The ranked-score replay
 * needs every score (successive bests over time), so it opts out.
 */
function baseFrom(p: MetricParams, bestOnly: boolean): string {
  const R = p.ruleset ?? 0;
  return `FROM scores s
    JOIN beatmaps b ON b.id = s.beatmap_id
    JOIN beatmapsets st ON st.id = b.beatmapset_id
    LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
    WHERE s.ruleset = ${R}
      AND ${bestOnly ? "s.id = u.best_lazer_score_id AND " : ""}${mapWhere(p.map, { ruleset: R, pool: p.pool })} AND ${scoreWhere(p.score, isInverted(p))}`;
}

/** Goal-mode countdown: count the played maps whose best fails the conditions. */
function isInverted(p: MetricParams): boolean {
  return p.kind === "count" && p.descending === true && p.invert === true;
}

/**
 * Total maps matching the map conditions (denominator for "total" mode).
 * Achievement-based conditions (country #1, global top) are ignored here —
 * same rule as the per-bucket denominators, so a "global top 8" metric reads
 * "my top 8s / every map in the range" instead of a meaningless 100%.
 */
function mapTotal(p: MetricParams): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) c FROM beatmaps b
         JOIN beatmapsets st ON st.id = b.beatmapset_id
         LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${p.ruleset ?? 0}
         WHERE ${mapWhere(p.map, { ignoreCountry1: true, ruleset: p.ruleset ?? 0, pool: p.pool })}`
      )
      .get() as { c: number }
  ).c;
}

/** Per-bucket completion (maps matched vs available) for a count metric. */
function countByBucket(p: MetricParams): MetricResult["byBucket"] {
  const db = getDb();
  const base = baseFrom(p, true);
  // hasOwn: "constructor" as breakdown would reach Object.prototype
  const dim = Object.hasOwn(BUCKETS, p.breakdown ?? "sr")
    ? BUCKETS[p.breakdown ?? "sr"]
    : BUCKETS.sr;
  const matched = db
    .prepare(
      `SELECT ${dim.expr} AS bucket, COUNT(DISTINCT s.beatmap_id) AS value
       ${base} AND ${dim.notNull} IS NOT NULL GROUP BY bucket`
    )
    .all() as { bucket: number | string; value: number }[];
  // Denominator = every map in the bucket. For a country-#1 metric we drop the
  // #1 filter here, so the bars read "my #1s / all maps in the range".
  const totals = db
    .prepare(
      `SELECT ${dim.expr} AS bucket, COUNT(*) AS total
       FROM beatmaps b
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${p.ruleset ?? 0}
       WHERE ${mapWhere(p.map, { ignoreCountry1: true, ruleset: p.ruleset ?? 0, pool: p.pool })} AND ${dim.notNull} IS NOT NULL
       GROUP BY bucket ORDER BY bucket`
    )
    .all() as { bucket: number | string; total: number }[];
  const matchedBy = new Map(matched.map((r) => [r.bucket, r.value]));
  return totals.map((t) => ({
    bucket: t.bucket,
    value: matchedBy.get(t.bucket) ?? 0,
    total: t.total,
  }));
}

function evalCount(p: MetricParams, gran: "month" | "day"): MetricResult {
  const db = getDb();
  // Replay of successive bests: at any point in time a map counts iff its
  // best score AT THAT TIME matched the conditions (leaderboard semantics —
  // a map can leave the metric when a higher score with e.g. a worse grade
  // takes over as best). The final state equals the best-only SQL count.
  const rows = db
    .prepare(
      `SELECT s.beatmap_id AS bid, s.ended_at AS at,
         COALESCE(s.classic_total_score, s.total_score) AS v,
         (${scoreWhere(p.score, isInverted(p))}) AS matches
       FROM scores s
       JOIN beatmaps b ON b.id = s.beatmap_id
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${p.ruleset ?? 0}
       WHERE s.ruleset = ${p.ruleset ?? 0}
         AND ${mapWhere(p.map, { ruleset: p.ruleset ?? 0, pool: p.pool })} AND s.passed = 1
       ORDER BY s.ended_at`
    )
    .all() as { bid: number; at: string; v: number; matches: number }[];
  const best = new Map<number, number>();
  const inSet = new Set<number>();
  let total = 0;
  const points: { at: string; total: number }[] = [];
  for (const r of rows) {
    const prev = best.get(r.bid) ?? -1;
    if (r.v <= prev) continue; // not a new best: never affects the LB state
    best.set(r.bid, r.v);
    const matches = r.matches === 1;
    const was = inSet.has(r.bid);
    if (matches === was) continue;
    if (matches) inSet.add(r.bid);
    else inSet.delete(r.bid);
    total += matches ? 1 : -1;
    points.push({ at: r.at, total });
  }
  return {
    count: total,
    total: mapTotal(p),
    step: p.step,
    // countdown metrics: the conditions select the maps still to fix, so the
    // celebrated milestones are downward (900, 800, … 0 left)
    milestones: p.descending
      ? thresholdsDesc(points, p.step)
      : thresholds(points, p.step),
    evolution: p.showEvolution ? bucketEvolution(points, gran) : null,
    byBucket: countByBucket(p),
  };
}

/** Ranked-score metric: cumulative sum of best classic score per map. */
function evalRankedScore(p: MetricParams, gran: "month" | "day"): MetricResult {
  const db = getDb();
  const R = p.ruleset ?? 0;
  // LEADERBOARD SEMANTICS, like the count metrics: a map contributes the
  // score that actually counts on it — its BEST — and only if that best
  // matches the conditions. Summing the best AMONG the matching scores
  // instead would produce a total that no real ranked score ever had (a
  // beaten DT play is not part of your ranked score).
  const rows = db
    .prepare(
      `SELECT s.beatmap_id AS bid, s.ended_at AS at, ${RANKED_CLASSIC} AS v,
         (${scoreWhere(p.score, isInverted(p))}) AS matches
       FROM scores s
       JOIN beatmaps b ON b.id = s.beatmap_id
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       WHERE s.ruleset = ${R} AND s.passed = 1
         AND ${mapWhere(p.map, { ruleset: R, pool: p.pool })}
       ORDER BY s.ended_at`
    )
    .all() as { bid: number; at: string; v: number; matches: number }[];
  // Replay: track each map's running best, and what it contributes. The
  // total can go DOWN (a new best that fails the conditions replaces one
  // that passed) — the same rule the count metrics follow.
  const bestVal = new Map<number, number>();
  const contrib = new Map<number, number>();
  let total = 0;
  const points: { at: string; total: number }[] = [];
  for (const r of rows) {
    if (r.v <= (bestVal.get(r.bid) ?? -1)) continue; // not a new best
    bestVal.set(r.bid, r.v);
    const now = r.matches === 1 ? r.v : 0;
    const before = contrib.get(r.bid) ?? 0;
    if (now === before) continue;
    contrib.set(r.bid, now);
    total += now - before;
    points.push({ at: r.at, total });
  }
  return {
    count: total,
    total: 0, // "total available" not meaningful for a score sum
    step: p.step,
    milestones: thresholds(points, p.step),
    evolution: p.showEvolution ? bucketEvolution(points, gran) : null,
    byBucket: [],
  };
}

/**
 * Weighted-pp metric: the official profile rules applied to the matching set.
 * ONE score per map — the HIGHEST pp, regardless of the tracker's classic
 * best —, descending weights 0.95^i, plus the bonus
 * 416.6667 × (1 − 0.995^min(n, 1000)) (official wiki formula; n = maps with a
 * pp score in the set, max bonus 413.894). Loved maps drop out naturally
 * (their scores have no pp). Successive pp-bests are replayed chronologically
 * for milestones and the evolution chart.
 */
function evalPp(p: MetricParams, gran: "month" | "day"): MetricResult {
  const db = getDb();
  const base = baseFrom(p, false);
  const rows = db
    .prepare(
      `SELECT s.beatmap_id AS bid, s.ended_at AS at, s.pp AS pp ${base}
         AND s.pp IS NOT NULL AND s.passed = 1
       ORDER BY s.ended_at`
    )
    .all() as { bid: number; at: string; pp: number }[];

  const bestPp = new Map<number, number>();
  const sorted: number[] = []; // descending pp, one per map
  const WEIGHT_CAP = 600; // 0.95^600 ≈ 4e-14: nothing beyond contributes
  const firstAtMost = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sorted[m] > v) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const weightedTotal = () => {
    let t = 0;
    let w = 1;
    const n = Math.min(sorted.length, WEIGHT_CAP);
    for (let i = 0; i < n; i++) {
      t += sorted[i] * w;
      w *= 0.95;
    }
    return t;
  };
  const bonusOf = (n: number) =>
    416.6667 * (1 - Math.pow(0.995, Math.min(n, 1000)));

  const points: { at: string; total: number }[] = [];
  for (const r of rows) {
    const prev = bestPp.get(r.bid);
    if (prev != null && r.pp <= prev) continue;
    if (prev != null) sorted.splice(firstAtMost(prev), 1);
    bestPp.set(r.bid, r.pp);
    sorted.splice(firstAtMost(r.pp), 0, r.pp);
    points.push({ at: r.at, total: weightedTotal() + bonusOf(bestPp.size) });
  }
  return {
    count: points.length > 0 ? points[points.length - 1].total : 0,
    total: 0, // "total available" not meaningful for weighted pp
    step: p.step,
    milestones: thresholds(points, p.step),
    evolution: p.showEvolution ? bucketEvolution(points, gran) : null,
    byBucket: [],
    pp: { bonus: bonusOf(bestPp.size), scoreCount: bestPp.size },
  };
}

// Cache metric results, keyed by params+granularity and a "scores version"
// (count + max id). Editing one metric only misses its own key; unchanged
// metrics stay cached, so edit/delete refresh instantly. New scores bump the
// version and everything recomputes on the next call.
const cache = new Map<string, { version: string; result: MetricResult }>();
const CACHE_MAX = 80;

export function evalMetric(
  p: MetricParams,
  gran: "month" | "day"
): MetricResult {
  p = sanitized(p);
  const version = scoresVersion();
  const key = `${JSON.stringify(p)}|${gran}`;
  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.result;
  const result =
    p.kind === "ranked_score"
      ? evalRankedScore(p, gran)
      : p.kind === "pp"
        ? evalPp(p, gran)
        : evalCount(p, gran);
  cache.set(key, { version, result });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return result;
}

/** Lean count + per-bucket breakdown for the live builder preview (no evolution). */
export function previewMetric(p: MetricParams): {
  count: number;
  byBucket: { bucket: number | string; value: number; total: number }[];
} {
  p = sanitized(p);
  if (p.kind === "pp") {
    const r = evalPp({ ...p, showEvolution: false }, "month");
    return { count: Math.round(r.count), byBucket: [] };
  }
  const db = getDb();
  // bestOnly for every kind: a ranked-score metric sums the maps' BESTS that
  // match, not the best matching score (see evalRankedScore)
  const base = baseFrom(p, true);
  const count =
    p.kind === "ranked_score"
      ? (
          db
            .prepare(`SELECT COALESCE(SUM(${RANKED_CLASSIC}), 0) v ${base}`)
            .get() as { v: number }
        ).v
      : (
          db
            .prepare(`SELECT COUNT(DISTINCT s.beatmap_id) c ${base}`)
            .get() as { c: number }
        ).c;
  const byBucket = p.kind === "ranked_score" ? [] : countByBucket(p);
  return { count, byBucket };
}
