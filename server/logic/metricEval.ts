import { getDb } from "../db/db.js";
import {
  mapWhere,
  scoreWhere,
  type MetricParams,
} from "./metrics.js";

export interface MetricResult {
  count: number;
  total: number; // maps matching the map conditions (denominator for "total" mode)
  step: number;
  milestones: { threshold: number; at: string }[];
  evolution: { period: string; value: number }[] | null;
  // per-star-rating breakdown: value matched, total available in the bucket
  bySr: { sr: number; value: number; total: number }[];
}

const RANKED_CLASSIC = "COALESCE(s.classic_total_score, s.total_score)";
const SR_BUCKET = "MIN(CAST(b.star_rating AS INTEGER), 10)";

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

/** Count metric: number of maps with at least one qualifying score. */
/** Per-star-rating completion (maps matched vs available) for a count metric. */
function countBySr(p: MetricParams): MetricResult["bySr"] {
  const db = getDb();
  const base = baseFrom(p);
  const matched = db
    .prepare(
      `SELECT ${SR_BUCKET} AS sr, COUNT(DISTINCT s.beatmap_id) AS value
       ${base} AND b.star_rating IS NOT NULL GROUP BY sr`
    )
    .all() as { sr: number; value: number }[];
  // Denominator = every map in the star-rating band. For a country-#1 metric we
  // drop the #1 filter here, so the bars read "my #1s / all maps in the range".
  const totals = db
    .prepare(
      `SELECT MIN(CAST(b.star_rating AS INTEGER), 10) AS sr, COUNT(*) AS total
       FROM beatmaps b
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       WHERE ${mapWhere(p.map, { ignoreCountry1: true })} AND b.star_rating IS NOT NULL GROUP BY sr ORDER BY sr`
    )
    .all() as { sr: number; total: number }[];
  const matchedBy = new Map(matched.map((r) => [r.sr, r.value]));
  return totals.map((t) => ({ sr: t.sr, value: matchedBy.get(t.sr) ?? 0, total: t.total }));
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
    bySr: countBySr(p),
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
  const bySr = (
    db
      .prepare(
        `SELECT MIN(CAST(star_rating AS INTEGER), 10) AS sr, COALESCE(SUM(mv), 0) AS value
         FROM (
           SELECT b.star_rating AS star_rating, MAX(${RANKED_CLASSIC}) AS mv
           ${base} AND b.star_rating IS NOT NULL GROUP BY s.beatmap_id
         ) GROUP BY sr ORDER BY sr`
      )
      .all() as { sr: number; value: number }[]
  ).map((r) => ({ ...r, total: 0 }));
  return {
    count: total,
    total: 0, // "total available" not meaningful for a score sum
    step: p.step,
    milestones: thresholds(points, p.step),
    evolution: p.showEvolution ? bucketEvolution(points, gran) : null,
    bySr,
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

/** Lean count + per-SR breakdown for the live builder preview (no evolution). */
export function previewMetric(p: MetricParams): {
  count: number;
  bySr: { sr: number; value: number; total: number }[];
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
  const bySr = p.kind === "ranked_score" ? [] : countBySr(p);
  return { count, bySr };
}
