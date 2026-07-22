import { getDb } from "../db/db.js";
import {
  mapWhere,
  scoreWhere,
  type MetricBreakdown,
  type MetricParams,
} from "./metrics.js";

export interface MetricResult {
  count: number;
  total: number; // maps matching the map conditions (denominator for "total" mode)
  step: number;
  milestones: { threshold: number; at: string }[];
  evolution: { period: string; value: number }[] | null;
  /** per-bucket completion in the chosen breakdown dimension */
  byBucket: { bucket: number | string; value: number; total: number }[];
}

/** Bucket SQL per breakdown dimension (same buckets as the dashboard). */
const BUCKETS: Record<MetricBreakdown, { expr: string; notNull: string }> = {
  sr: { expr: "MIN(CAST(b.star_rating AS INTEGER), 10)", notNull: "b.star_rating" },
  year: { expr: "strftime('%Y', st.ranked_date)", notNull: "st.ranked_date" },
  length: { expr: "MIN(CAST(b.total_length / 60 AS INTEGER), 10)", notNull: "b.total_length" },
  combo: { expr: "MIN(CAST(b.max_combo / 250 AS INTEGER), 8)", notNull: "b.max_combo" },
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

/** Base FROM/JOIN + WHERE for a metric's conditions. */
function baseFrom(p: MetricParams): string {
  return `FROM scores s
    JOIN beatmaps b ON b.id = s.beatmap_id
    JOIN beatmapsets st ON st.id = b.beatmapset_id
    LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
    WHERE ${mapWhere(p.map)} AND ${scoreWhere(p.score)}`;
}

/** Total maps matching the map conditions (denominator for "total" mode). */
function mapTotal(p: MetricParams): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) c FROM beatmaps b
         JOIN beatmapsets st ON st.id = b.beatmapset_id
         LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
         WHERE ${mapWhere(p.map)}`
      )
      .get() as { c: number }
  ).c;
}

/** Per-bucket completion (maps matched vs available) for a count metric. */
function countByBucket(p: MetricParams): MetricResult["byBucket"] {
  const db = getDb();
  const base = baseFrom(p);
  const dim = BUCKETS[p.breakdown ?? "sr"] ?? BUCKETS.sr;
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
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       WHERE ${mapWhere(p.map, { ignoreCountry1: true })} AND ${dim.notNull} IS NOT NULL
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
  const base = baseFrom(p);
  const dates = (
    db
      .prepare(`SELECT MIN(s.ended_at) AS at ${base} GROUP BY s.beatmap_id ORDER BY at`)
      .all() as { at: string }[]
  ).map((r) => r.at);
  const points = dates.map((at, i) => ({ at, total: i + 1 }));
  return {
    count: dates.length,
    total: mapTotal(p),
    step: p.step,
    milestones: thresholds(points, p.step),
    evolution: p.showEvolution ? bucketEvolution(points, gran) : null,
    byBucket: countByBucket(p),
  };
}

/** Ranked-score metric: cumulative sum of best classic score per map. */
function evalRankedScore(p: MetricParams, gran: "month" | "day"): MetricResult {
  const db = getDb();
  const base = baseFrom(p);
  const rows = db
    .prepare(
      `SELECT s.beatmap_id AS bid, s.ended_at AS at, ${RANKED_CLASSIC} AS v ${base} ORDER BY at`
    )
    .all() as { bid: number; at: string; v: number }[];
  const best = new Map<number, number>();
  let total = 0;
  const points: { at: string; total: number }[] = [];
  for (const r of rows) {
    const prev = best.get(r.bid) ?? 0;
    if (r.v <= prev) continue;
    best.set(r.bid, r.v);
    total += r.v - prev;
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

// Cache metric results, keyed by params+granularity and a "scores version"
// (count + max id). Editing one metric only misses its own key; unchanged
// metrics stay cached, so edit/delete refresh instantly. New scores bump the
// version and everything recomputes on the next call.
const cache = new Map<string, { version: string; result: MetricResult }>();
const CACHE_MAX = 80;

function scoresVersion(): string {
  const r = getDb()
    .prepare("SELECT COUNT(*) c, COALESCE(MAX(id), 0) m FROM scores")
    .get() as { c: number; m: number };
  return `${r.c}-${r.m}`;
}

export function evalMetric(
  p: MetricParams,
  gran: "month" | "day"
): MetricResult {
  const version = scoresVersion();
  const key = `${JSON.stringify(p)}|${gran}`;
  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.result;
  const result = p.kind === "ranked_score" ? evalRankedScore(p, gran) : evalCount(p, gran);
  cache.set(key, { version, result });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return result;
}

/** Lean count + per-bucket breakdown for the live builder preview (no evolution). */
export function previewMetric(p: MetricParams): {
  count: number;
  byBucket: { bucket: number | string; value: number; total: number }[];
} {
  const db = getDb();
  const base = baseFrom(p);
  const count =
    p.kind === "ranked_score"
      ? (
          db
            .prepare(
              `SELECT COALESCE(SUM(mv), 0) v FROM (
                 SELECT MAX(${RANKED_CLASSIC}) mv ${base} GROUP BY s.beatmap_id
               )`
            )
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
