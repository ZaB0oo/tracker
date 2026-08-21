import { Router } from "express";
import { getDb } from "../db/db.js";
import { keysWhere, maniaKeysSql, parseRulesetParam, poolWhere, statusIn } from "../logic/rulesets.js";
import { classicFromStandardised } from "../logic/rulesets.js";
import {
  CURVE_STEPS,
  N_OBJ,
  computeSkillCurve,
  ensureMissingFresh,
  fitSkillCurve,
  scoresVersion,
  witherScore,
  witherSql,
} from "../logic/scoreSql.js";

export const statsRouter = Router();

/**
 * Pool condition + the mania key-count filter of the request, so every dashboard
 * panel narrows exactly like the Maps table when 4K/7K/Other are toggled.
 */
function withKeys(
  ruleset: number,
  req: { query: Record<string, unknown> },
  pool: string
): string {
  const keys = keysWhere(ruleset, req.query.keys ? String(req.query.keys) : undefined);
  return keys ? `${pool} AND ${keys}` : pool;
}

// The dashboard summary runs 13 aggregates over the whole pool (~10 s on a full
// osu! catalog) and is asked for on every visit. Kept per mode/pool/keys, thrown
// away as soon as a score lands (a fresh play shows up at once) and after a
// minute, so the map count still climbs while an import runs.
const statsCache = new Map<
  string,
  { version: string; at: number; payload: unknown }
>();
const STATS_TTL_MS = 60_000;

statsRouter.get("/stats", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const POOL = withKeys(R, req, poolWhere(R, String(req.query.pool ?? "")));
  // scope=ranked: the whole dashboard ignores loved maps
  const STATUSES = statusIn(String(req.query.scope ?? ""));

  const version = scoresVersion();
  // POOL/STATUSES are the canonical SQL strings (pool+keys fold into POOL):
  // junk query values collapse into one entry instead of growing the cache
  const cacheKey = `${R}|${POOL}|${STATUSES}`;
  const hit = statsCache.get(cacheKey);
  if (hit && hit.version === version && Date.now() - hit.at < STATS_TTL_MS)
    return res.json(hit.payload);

  ensureMissingFresh();
  const db = getDb();
  const one = <T>(sql: string) => db.prepare(sql).get() as T;

  const totals = one<{
    total: number;
    played: number;
    fetched: number;
    ranked_total: number;
    ranked_played: number;
    loved_total: number;
    loved_played: number;
    country_firsts: number;
    country_ranked: number;
    country_loved: number;
    fc: number;
    fc_ranked: number;
    fc_loved: number;
  }>(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
      SUM(CASE WHEN u.fetched_at IS NOT NULL THEN 1 ELSE 0 END) fetched,
      SUM(CASE WHEN b.status IN (1, 2) THEN 1 ELSE 0 END) ranked_total,
      SUM(CASE WHEN b.status IN (1, 2) AND u.played = 1 THEN 1 ELSE 0 END) ranked_played,
      SUM(CASE WHEN b.status = 4 THEN 1 ELSE 0 END) loved_total,
      SUM(CASE WHEN b.status = 4 AND u.played = 1 THEN 1 ELSE 0 END) loved_played,
      SUM(COALESCE(u.country_first, 0)) country_firsts,
      SUM(CASE WHEN b.status IN (1, 2) THEN COALESCE(u.country_first, 0) ELSE 0 END) country_ranked,
      SUM(CASE WHEN b.status = 4 THEN COALESCE(u.country_first, 0) ELSE 0 END) country_loved,
      SUM(COALESCE(u.best_fc, 0)) fc,
      SUM(CASE WHEN b.status IN (1, 2) THEN COALESCE(u.best_fc, 0) ELSE 0 END) fc_ranked,
      SUM(CASE WHEN b.status = 4 THEN COALESCE(u.best_fc, 0) ELSE 0 END) fc_loved
    FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
    WHERE ${POOL} AND b.status IN ${STATUSES}`);

  const scoreSums = one<{
    lazer: number;
    classic: number;
    wither: number;
  }>(`
    SELECT
      COALESCE(SUM(s.total_score), 0) lazer,
      COALESCE(SUM(COALESCE(s.classic_total_score, s.total_score)), 0) classic,
      ${
        // wither is std-only (its formula uses std object counts): the other
        // modes showed a non-zero total next to a missing_wither of NULL
        R === 0
          ? `COALESCE(SUM(CASE WHEN ${N_OBJ} > 0
        THEN ${witherSql("s.total_score")}
        ELSE s.total_score END), 0)`
          : "0"
      } wither
    FROM beatmap_user u
    JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
    LEFT JOIN scores s ON s.id = u.best_lazer_score_id
    WHERE u.played = 1 AND ${POOL} AND b.status IN ${STATUSES}`);

  // Total realistic missing over the WHOLE catalog: unplayed maps count for
  // their full prediction.
  const missingSums = one<{
    missing: number;
    missingClassic: number;
    missingWither: number;
  }>(`
    SELECT
      COALESCE(SUM(u.missing_lazer), 0) missing,
      COALESCE(SUM(u.missing_classic), 0) missingClassic,
      COALESCE(SUM(u.missing_wither), 0) missingWither
    FROM beatmaps b
    LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
    WHERE ${POOL} AND b.status IN ${STATUSES}`);

  const oneMillions =
    R === 3
      ? one<{ c: number }>(`
          SELECT COUNT(DISTINCT s.beatmap_id) c
          FROM scores s
          JOIN beatmaps b ON b.id = s.beatmap_id
          WHERE s.ruleset = 3 AND s.passed = 1
            AND COALESCE(json_extract(s.raw,'$.total_score_without_mods'), s.total_score) = 1000000
            AND ${POOL} AND b.status IN ${STATUSES}`).c
      : 0;

  // Global tops counters (cumulative: top8 includes top1, etc.). All zeros
  // until the global sweep has run at least once.
  const globalTops = one<{
    top1: number; top8: number; top15: number;
    top25: number; top50: number; top100: number;
    checked: number;
  }>(`
    SELECT
      COALESCE(SUM(u.global_rank = 1), 0) top1,
      COALESCE(SUM(u.global_rank <= 8), 0) top8,
      COALESCE(SUM(u.global_rank <= 15), 0) top15,
      COALESCE(SUM(u.global_rank <= 25), 0) top25,
      COALESCE(SUM(u.global_rank <= 50), 0) top50,
      COALESCE(SUM(u.global_rank <= 100), 0) top100,
      COUNT(*) checked
    FROM beatmap_user u
    JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
    WHERE ${POOL} AND b.status IN ${STATUSES} AND u.global_rank IS NOT NULL`);

  // osu! leaderboard semantics: the map's grade/FC state = that of the score
  // that counts on the LB, i.e. the BEST by score (not the best grade).
  const grades = db
    .prepare(
      `SELECT s.rank AS grade, COUNT(*) c
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE ${POOL} AND b.status IN ${STATUSES}
       GROUP BY s.rank`
    )
    .all();

  const fc = db
    .prepare(
      `SELECT s.fc_state, COUNT(*) c
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE ${POOL} AND b.status IN ${STATUSES}
       GROUP BY s.fc_state`
    )
    .all();

  // Extra completion gauges (PFC / SS / S+), taken from the BEST score only —
  // osu! leaderboard semantics, same as the Grades card: an old SS beaten by a
  // higher non-SS play does not count. top100 comes from the live global rank.
  // mania 1M club: monotone "ever achieved" (a later higher modded best does
  // not remove the 1M), matching how the community counts them
  const ONEM_JOIN =
    R === 3
      ? `LEFT JOIN (SELECT DISTINCT beatmap_id FROM scores
           WHERE ruleset = 3 AND passed = 1
             AND COALESCE(json_extract(raw,'$.total_score_without_mods'), total_score) = 1000000
         ) om ON om.beatmap_id = b.id`
      : "";
  const FLAGS_JOIN = `LEFT JOIN scores bs ON bs.id = u.best_lazer_score_id ${ONEM_JOIN}`;
  const GAUGE_COLS = `,
    SUM(CASE WHEN bs.fc_state = 0 THEN 1 ELSE 0 END) pfc,
    SUM(CASE WHEN bs.rank IN ('X','XH') THEN 1 ELSE 0 END) ss,
    SUM(CASE WHEN bs.rank IN ('S','SH') THEN 1 ELSE 0 END) gradeS,
    SUM(CASE WHEN bs.rank = 'A' THEN 1 ELSE 0 END) gradeA,
    SUM(CASE WHEN bs.rank = 'B' THEN 1 ELSE 0 END) gradeB,
    SUM(CASE WHEN bs.rank = 'C' THEN 1 ELSE 0 END) gradeC,
    SUM(CASE WHEN bs.rank = 'D' THEN 1 ELSE 0 END) gradeD,
    SUM(CASE WHEN u.played = 1 AND COALESCE(u.best_fc, 0) = 0 THEN 1 ELSE 0 END) nonfc,
    SUM(CASE WHEN u.global_rank = 1 THEN 1 ELSE 0 END) top1,
    SUM(CASE WHEN u.global_rank <= 8 THEN 1 ELSE 0 END) top8,
    SUM(CASE WHEN u.global_rank <= 15 THEN 1 ELSE 0 END) top15,
    SUM(CASE WHEN u.global_rank <= 25 THEN 1 ELSE 0 END) top25,
    SUM(CASE WHEN u.global_rank <= 50 THEN 1 ELSE 0 END) top50,
    SUM(CASE WHEN u.global_rank <= 100 THEN 1 ELSE 0 END) top100${
      R === 3 ? ",\n    SUM(CASE WHEN om.beatmap_id IS NOT NULL THEN 1 ELSE 0 END) onem" : ""
    }`;

  // Converts bucket by their PER-MODE attributes (like /table and /snapshot):
  // without this the live "by star rating"/"by max combo" panels and the time
  // machine at today's date disagreed by construction on non-std tabs.
  const CA_JOIN =
    R === 0
      ? ""
      : `LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}`;
  const SR_EXPR =
    R === 0 ? "b.star_rating" : "COALESCE(ca.star_rating, b.star_rating)";
  const COMBO_EXPR =
    R === 0 ? "b.max_combo" : "COALESCE(ca.max_combo, b.max_combo)";

  const bySr = db
    .prepare(
      `SELECT MIN(CAST(${SR_EXPR} AS INTEGER), 10) sr,
        COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
        SUM(COALESCE(u.country_first, 0)) country,
        SUM(COALESCE(u.best_fc, 0)) fc${GAUGE_COLS}
       FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       ${FLAGS_JOIN} ${CA_JOIN}
       WHERE ${POOL} AND b.status IN ${STATUSES} AND ${SR_EXPR} IS NOT NULL
       GROUP BY sr ORDER BY sr`
    )
    .all();

  const byYear = db
    .prepare(
      `SELECT strftime('%Y', st.ranked_date) year,
        COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
        SUM(COALESCE(u.country_first, 0)) country,
        SUM(COALESCE(u.best_fc, 0)) fc${GAUGE_COLS}
       FROM beatmaps b
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       ${FLAGS_JOIN}
       WHERE ${POOL} AND b.status IN ${STATUSES} AND st.ranked_date IS NOT NULL
       GROUP BY year ORDER BY year`
    )
    .all();

  // Generic distributions by capped integer bucket (AR/OD/HP/CS, length, combo)
  const dist = (expr: string, cap: number) =>
    db
      .prepare(
        `SELECT MIN(CAST(${expr} AS INTEGER), ${cap}) AS bucket,
          COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
          SUM(COALESCE(u.country_first, 0)) country,
          SUM(COALESCE(u.best_fc, 0)) fc${GAUGE_COLS}
         FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
         ${FLAGS_JOIN} ${CA_JOIN}
         WHERE ${POOL} AND b.status IN ${STATUSES} AND ${expr} IS NOT NULL
         GROUP BY bucket ORDER BY bucket`
      )
      .all();

  // hero rows (Global / Ranked / Loved): same gauges, bucketed by status
  const byStatus = db
    .prepare(
      `SELECT CASE WHEN b.status = 4 THEN 'loved' ELSE 'ranked' END AS bucket,
        COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
        SUM(COALESCE(u.country_first, 0)) country,
        SUM(COALESCE(u.best_fc, 0)) fc${GAUGE_COLS}
       FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       ${FLAGS_JOIN}
       WHERE ${POOL} AND b.status IN ${STATUSES}
       GROUP BY bucket`
    )
    .all();

  // Playback-rate histogram (0.1 buckets, 0.5x-2.0x): the rate of each map's
  // BEST. Unlike the other dimensions a rate is a property of the SCORE, so
  // "total" has no meaning here — only played/FC/grades do.
  const byRate = db
    .prepare(
      `SELECT MIN(MAX(CAST(s.rate * 10 AS INTEGER), 5), 20) AS bucket,
        COUNT(*) played,
        SUM(COALESCE(u.best_fc, 0)) fc,
        SUM(CASE WHEN s.fc_state = 0 THEN 1 ELSE 0 END) pfc,
        SUM(CASE WHEN s.rank IN ('X','XH') THEN 1 ELSE 0 END) ss,
        SUM(CASE WHEN s.rank IN ('S','SH') THEN 1 ELSE 0 END) gradeS,
        SUM(CASE WHEN s.rank = 'A' THEN 1 ELSE 0 END) gradeA,
        SUM(CASE WHEN s.rank = 'B' THEN 1 ELSE 0 END) gradeB,
        SUM(CASE WHEN s.rank = 'C' THEN 1 ELSE 0 END) gradeC,
        SUM(CASE WHEN s.rank = 'D' THEN 1 ELSE 0 END) gradeD,
        SUM(CASE WHEN COALESCE(u.best_fc, 0) = 0 THEN 1 ELSE 0 END) nonfc,
        SUM(CASE WHEN u.global_rank = 1 THEN 1 ELSE 0 END) top1,
        SUM(CASE WHEN u.global_rank <= 8 THEN 1 ELSE 0 END) top8,
        SUM(CASE WHEN u.global_rank <= 15 THEN 1 ELSE 0 END) top15,
        SUM(CASE WHEN u.global_rank <= 25 THEN 1 ELSE 0 END) top25,
        SUM(CASE WHEN u.global_rank <= 50 THEN 1 ELSE 0 END) top50,
        SUM(CASE WHEN u.global_rank <= 100 THEN 1 ELSE 0 END) top100,
        ${R === 3 ? "SUM(CASE WHEN om.beatmap_id IS NOT NULL THEN 1 ELSE 0 END)" : "0"} onem,
        SUM(COALESCE(u.country_first, 0)) country
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
       JOIN scores s ON s.id = u.best_lazer_score_id
       ${ONEM_JOIN}
       WHERE ${POOL} AND b.status IN ${STATUSES}
       GROUP BY bucket ORDER BY bucket`
    )
    .all();

  const byAr = dist("b.ar", 10);
  const byOd = dist("b.od", 10);
  const byHp = dist("b.hp", 10);
  // mania: the "CS" dimension IS the key count, not the raw circle size. Capped
  // at 18 because dual-stage maps go up to 9K+9K: stopping at 10 hid every one
  // of them behind a single "10+" bucket.
  const byCs = dist(R === 3 ? maniaKeysSql() : "b.cs", R === 3 ? 18 : 10);
  const byLen = dist("b.total_length / 60", 10); // one-minute buckets
  const byCombo = dist(`${COMBO_EXPR} / 250`, 10); // buckets of 250, 2500+

  const payload = {
    totals, scoreSums: { ...scoreSums, ...missingSums }, grades, fc, globalTops,
    oneMillions,
    bySr, byYear, byAr, byOd, byHp, byCs, byLen, byCombo, byStatus, byRate,
  };
  statsCache.set(cacheKey, { version, at: Date.now(), payload });
  while (statsCache.size > 16)
    statsCache.delete(statsCache.keys().next().value!);
  res.json(payload);
});

/** The score-curve x-axis dimensions the API accepts (anything else: sr). */
const CURVE_DIM_KEYS = new Set(["sr", "ar", "od", "cs", "hp", "length", "combo", "month"]);

// /skill-curve answers ~10 req/min (60s refetch + every dim/scope change) and
// the non-sr dims pull every best row per request: cache like the others.
const curveCache = new Map<string, { version: string; payload: unknown }>();

/** Combo width of one score-curve band; mania combos run far higher. */
function comboCurveStep(R: number): number {
  return R === 3 ? 60 : R === 2 ? 25 : 20;
}

/** Bucket SQL of the score-curve x-axis dimensions (q = bucket index). */
function curveDimSql(
  R: number,
  dim: string
): { expr: string; notNull: string; steps: number } {
  const SRX = R === 0 ? "b.star_rating" : "COALESCE(ca.star_rating, b.star_rating)";
  const COMBO = R === 0 ? "b.max_combo" : "COALESCE(ca.max_combo, b.max_combo)";
  const tenth = (col: string) => ({
    expr: `MIN(CAST(${col} * 10 AS INTEGER), 100)`,
    notNull: `${col} IS NOT NULL`,
    steps: 100,
  });
  switch (dim) {
    case "ar": return tenth("b.ar");
    case "od": return tenth("b.od");
    case "hp": return tenth("b.hp");
    case "cs":
      return R === 3
        ? { expr: `MIN(CAST(${maniaKeysSql()} AS INTEGER), 18)`, notNull: "b.cs IS NOT NULL", steps: 18 }
        : tenth("b.cs");
    case "length":
      return { expr: "MIN(CAST(b.total_length / 10 AS INTEGER), 60)", notNull: "b.total_length IS NOT NULL", steps: 60 };
    case "combo":
      return { expr: `MIN(CAST(${COMBO} / ${comboCurveStep(R)} AS INTEGER), 100)`, notNull: `${COMBO} IS NOT NULL`, steps: 100 };
    case "month":
      return {
        expr: "(CAST(strftime('%Y', st.ranked_date) AS INTEGER) - 2007) * 12 + CAST(strftime('%m', st.ranked_date) AS INTEGER) - 1",
        notNull: "st.ranked_date IS NOT NULL",
        steps: (new Date().getUTCFullYear() - 2007) * 12 + new Date().getUTCMonth(),
      };
    default:
      return { expr: `MIN(CAST(${SRX} * 10 AS INTEGER), ${CURVE_STEPS})`, notNull: `${SRX} IS NOT NULL`, steps: CURVE_STEPS };
  }
}

/**
 * GET /api/skill-curve — score-curve detail per band of the requested
 * dimension (?dim=sr|ar|od|cs|hp|length|combo|month): median of the bests,
 * number of bests backing it, maps in the band and its realistic missing.
 */
statsRouter.get("/skill-curve", (req, res) => {
  ensureMissingFresh();
  const db = getDb();
  const R = parseRulesetParam(req.query.ruleset);
  const POOL = withKeys(R, req, poolWhere(R, String(req.query.pool ?? "")));
  const STATUSES = statusIn(String(req.query.scope ?? ""));
  const caJoin =
    R === 0
      ? ""
      : `LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}`;
  const dimRaw = String(req.query.dim ?? "sr");
  const dim = CURVE_DIM_KEYS.has(dimRaw) ? dimRaw : "sr";
  const version = scoresVersion();
  const curveKey = `${R}|${POOL}|${STATUSES}|${dim}`;
  const curveHit = curveCache.get(curveKey);
  if (curveHit && curveHit.version === version) return res.json(curveHit.payload);
  const D = curveDimSql(R, dim);
  // beatmapsets is only read by the month axis; joining it everywhere cost a
  // PK probe per beatmap and silently dropped any map without a set row from
  // the totals (INNER JOIN semantics)
  const stJoin = dim === "month" ? "JOIN beatmapsets st ON st.id = b.beatmapset_id" : "";
  // per-band aggregates, along whatever axis the panel is looking at. The
  // curve follows the very same view as the sums: pool, keys, scope.
  const aggs = db
    .prepare(
      `SELECT ${D.expr} AS q,
        COUNT(*) total,
        SUM(COALESCE(u.played, 0)) played,
        SUM(u.missing_classic) missing_classic,
        SUM(u.missing_wither) missing_wither
       FROM beatmaps b
       ${stJoin}
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       ${caJoin}
       WHERE ${POOL} AND b.status IN ${STATUSES} AND ${D.notNull}
       GROUP BY q ORDER BY q`
    )
    .all() as {
    q: number;
    total: number;
    played: number | null;
    missing_classic: number | null;
    missing_wither: number | null;
  }[];
  let curveBuckets: ReturnType<typeof fitSkillCurve>;
  if (dim === "sr") {
    curveBuckets = computeSkillCurve(R, STATUSES, POOL).buckets;
  } else {
    const rows = db
      .prepare(
        `SELECT ${D.expr} AS q, s.total_score AS ts
         FROM beatmap_user u
         JOIN scores s ON s.id = u.best_lazer_score_id
         JOIN beatmaps b ON b.id = u.beatmap_id
         ${stJoin}
         ${caJoin}
         WHERE u.ruleset = ${R} AND ${POOL} AND b.status IN ${STATUSES} AND ${D.notNull}`
      )
      .all() as { q: number; ts: number }[];
    const samples = new Map<number, number[]>();
    for (const r of rows) {
      const arr = samples.get(r.q) ?? [];
      arr.push(r.ts);
      samples.set(r.q, arr);
    }
    curveBuckets = fitSkillCurve(samples, D.steps);
  }
  const byQ = new Map(aggs.map((a) => [a.q, a]));
  const payload = {
    dim,
    buckets: curveBuckets
      .filter((b) => (byQ.get(b.q)?.total ?? 0) > 0)
      .map((b) => {
        const a = byQ.get(b.q)!;
        return {
          q: b.q,
          predicted: b.value,
          raw: b.raw,
          samples: b.samples,
          inherited: b.samples < 5, // not enough bests => carried-over value
          total: a.total,
          played: a.played ?? 0,
          missingClassic: a.missing_classic ?? 0,
          missingWither: a.missing_wither ?? 0,
        };
      }),
  };
  curveCache.set(curveKey, { version, payload });
  while (curveCache.size > 16)
    curveCache.delete(curveCache.keys().next().value!);
  res.json(payload);
});

/**
 * GET /api/daily?year=YYYY — clears per day (first qualifying score of each
 * map) for the heatmap, plus all-time streak stats. Cheap: one GROUP BY.
 */
statsRouter.get("/daily", (req, res) => {
  const STATUSES = statusIn(String(req.query.scope ?? ""));
  const R = parseRulesetParam(req.query.ruleset);
  const POOL = withKeys(R, req, poolWhere(R, String(req.query.pool ?? "")));

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT date(m.at) d, COUNT(*) c FROM (
         SELECT MIN(s.ended_at) AS at FROM scores s
         JOIN beatmaps b ON b.id = s.beatmap_id
         WHERE ${POOL} AND b.status IN ${STATUSES} AND s.passed = 1
           AND s.ruleset = ${R}
         GROUP BY s.beatmap_id
       ) m GROUP BY d ORDER BY d`
    )
    .all() as { d: string; c: number }[];

  // The heatmap counts NEW clears, but the streak is about ACTIVITY: any
  // passed score keeps it alive, replaying an already-cleared map included —
  // breaking a streak on a farming day reads as a bug to any player.
  const playedDays = (
    db
      .prepare(
        `SELECT DISTINCT date(s.ended_at) d FROM scores s
         JOIN beatmaps b ON b.id = s.beatmap_id
         WHERE ${POOL} AND b.status IN ${STATUSES} AND s.passed = 1
           AND s.ruleset = ${R}
         ORDER BY d`
      )
      .all() as { d: string }[]
  ).map((r) => r.d);
  const daySet = new Set(playedDays);
  const DAY = 86_400_000;
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of playedDays) {
    const t = Date.parse(d);
    run = prev != null && t - prev === DAY ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  // current streak: counts back from today (or yesterday, still extendable)
  let current = 0;
  let cursor = new Date().toISOString().slice(0, 10);
  if (!daySet.has(cursor))
    cursor = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  while (daySet.has(cursor)) {
    current++;
    cursor = new Date(Date.parse(cursor) - DAY).toISOString().slice(0, 10);
  }
  const best = rows.reduce(
    (acc, r) => (r.c > acc.c ? r : acc),
    { d: "", c: 0 }
  );

  const year = Number(req.query.year) || new Date().getUTCFullYear();
  const years = rows.length
    ? { min: Number(rows[0].d.slice(0, 4)), max: Number(rows[rows.length - 1].d.slice(0, 4)) }
    : { min: year, max: year };
  res.json({
    year,
    years,
    days: rows.filter((r) => r.d.startsWith(String(year))),
    streak: { current, longest, best },
  });
});

/**
 * GET /api/timeline — cumulative daily snapshot of the account: clears / FCs /
 * country #1s (split all/ranked/loved), ranked classic, and the grade spread
 * (highest grade achieved per map — close to, but not exactly, the live
 * "grade of the best score"). One point per active day, whole series shipped
 * at once so the time-machine slider is instant client-side. Cached by scores
 * version.
 */
// Keyed by ruleset AND pool, not by scores version alone: a single slot served
// the first requesting mode's series to every other tab (osu! history under a
// mania tab).
const timelineCache = new Map<string, { version: string; payload: unknown }>();

const TIERS = ["D", "C", "B", "A", "S", "SH", "X", "XH"];

statsRouter.get("/timeline", (req, res) => {
  const STATUSES = statusIn(String(req.query.scope ?? ""));
  const R = parseRulesetParam(req.query.ruleset);
  const pool = String(req.query.pool ?? "");
  const POOL = withKeys(R, req, poolWhere(R, pool));

  const db = getDb();
  const version = scoresVersion();
  // keyed by the canonical SQL strings (pool+keys fold into POOL): junk
  // values collapse into one entry instead of growing the cache
  const cacheKey = `${R}|${POOL}|${STATUSES}`;
  const cached = timelineCache.get(cacheKey);
  if (cached && cached.version === version) return res.json(cached.payload);

  // s.ruleset = R matters as much as the pool: a convert map carries BOTH the
  // osu! score and the mode's score, and counting the wrong one turned another
  // mode's history into osu!'s.
  const CATALOG = `FROM scores s JOIN beatmaps b ON b.id = s.beatmap_id
    WHERE ${POOL} AND s.ruleset = ${R} AND b.status IN ${STATUSES}`;
  const firstDates = (cond: string): string[] =>
    (
      db
        .prepare(
          `SELECT MIN(s.ended_at) AS at ${CATALOG} AND ${cond} GROUP BY s.beatmap_id ORDER BY at`
        )
        .all() as { at: string }[]
    ).map((r) => r.at);
  const clears = firstDates("s.passed = 1");
  const clearsRanked = firstDates("s.passed = 1 AND b.status IN (1, 2)");
  const clearsLoved = firstDates("s.passed = 1 AND b.status = 4");
  // ranked classic + grade spread + FC: one replay of successive bests. What
  // is counted is the state OF THE CURRENT BEST (classic) score — the same
  // definition as the dashboard, so an SS later beaten by a higher-scoring S
  // stops counting as SS from that moment on, and an FC beaten by a
  // higher-scoring non-FC stops counting as an FC. Both series can therefore
  // go DOWN, which is why they are transitions and not first-dates.
  const scoreRows = db
    .prepare(
      `SELECT s.beatmap_id AS bid, s.ended_at AS at, s.rank AS rank,
         s.fc_state AS fcState, b.status AS status,
         COALESCE(s.classic_total_score, s.total_score) AS v
       ${CATALOG} AND s.passed = 1 ORDER BY s.ended_at`
    )
    .all() as {
    bid: number; at: string; rank: string; fcState: number; status: number; v: number;
  }[];
  const tierOf = new Map(TIERS.map((t, i) => [t, i]));
  const best = new Map<number, number>();
  const mapTier = new Map<number, number>();
  const mapFc = new Set<number>();
  const gradeEvents: { at: string; to: number | null; from: number | null; status: number }[] = [];
  const fcEvents: { at: string; delta: number; status: number }[] = [];
  let rankedTotal = 0;
  const rankedPts: { at: string; total: number }[] = [];
  for (const r of scoreRows) {
    const prev = best.get(r.bid) ?? 0;
    if (r.v <= prev) continue;
    best.set(r.bid, r.v);
    rankedTotal += r.v - prev;
    rankedPts.push({ at: r.at, total: rankedTotal });
    const to = tierOf.get(r.rank) ?? null;
    const from = mapTier.get(r.bid) ?? null;
    if (to !== from) {
      gradeEvents.push({ at: r.at, to, from, status: r.status });
      if (to == null) mapTier.delete(r.bid);
      else mapTier.set(r.bid, to);
    }
    const fcNow = r.fcState <= 1;
    if (fcNow !== mapFc.has(r.bid)) {
      fcEvents.push({ at: r.at, delta: fcNow ? 1 : -1, status: r.status });
      if (fcNow) mapFc.add(r.bid);
      else mapFc.delete(r.bid);
    }
  }

  // country #1s: logged transitions + silent initial takes dated to my best
  const events = db
    .prepare(
      // e.ruleset: the events are mode-tagged, and reading them all showed the
      // osu! #1 history on every other mode's timeline
      `SELECT e.beatmap_id AS bid, e.event, COALESCE(e.score_at, e.at) AS at,
         b.status AS status
       FROM country_events e JOIN beatmaps b ON b.id = e.beatmap_id
       WHERE e.ruleset = ${R} AND ${POOL} AND b.status IN ${STATUSES}
       ORDER BY COALESCE(e.score_at, e.at)`
    )
    .all() as { bid: number; event: string; at: string; status: number }[];
  const byMap = new Map<number, typeof events>();
  for (const e of events) {
    const arr = byMap.get(e.bid) ?? [];
    arr.push(e);
    byMap.set(e.bid, arr);
  }
  const held = db
    .prepare(
      `SELECT u.beatmap_id AS bid, s.ended_at AS at, b.status AS status
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE u.country_first = 1 AND ${POOL} AND b.status IN ${STATUSES}`
    )
    .all() as { bid: number; at: string; status: number }[];
  const deltas: { at: string; delta: number; status: number }[] = [];
  for (const r of held)
    if (!byMap.has(r.bid)) deltas.push({ at: r.at, delta: 1, status: r.status });
  for (const [, evs] of byMap) {
    if (evs[0].event === "lost")
      deltas.push({ at: evs[0].at, delta: 1, status: evs[0].status });
    for (const e of evs)
      deltas.push({ at: e.at, delta: e.event === "gained" ? 1 : -1, status: e.status });
  }
  deltas.sort((a, b) => a.at.localeCompare(b.at));

  // Global-top tiers over time: rank transitions from the events, initial
  // takes (recorded by the sweep without an event) dated at the best score
  // that earned them — the same approximation the snapshot uses.
  const gEvents = db
    .prepare(
      `SELECT e.beatmap_id AS bid, e.at, e.new_rank AS rank, b.status AS status
       FROM global_events e JOIN beatmaps b ON b.id = e.beatmap_id
       WHERE e.ruleset = ${R} AND ${POOL} AND b.status IN ${STATUSES}
       ORDER BY e.at`
    )
    .all() as { bid: number; at: string; rank: number | null; status: number }[];
  const gSeen = new Set(gEvents.map((e) => e.bid));
  const gHeld = db
    .prepare(
      `SELECT u.beatmap_id AS bid, u.global_rank AS rank, s.ended_at AS at,
         b.status AS status
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE u.global_rank IS NOT NULL AND ${POOL} AND b.status IN ${STATUSES}`
    )
    .all() as { bid: number; rank: number; at: string; status: number }[];
  const topEvts: { at: string; old: number; nw: number; status: number }[] = [];
  {
    const lastRank = new Map<number, number>();
    for (const r of gHeld)
      if (!gSeen.has(r.bid))
        topEvts.push({ at: r.at, old: 0, nw: r.rank, status: r.status });
    for (const e of gEvents) {
      const old = lastRank.get(e.bid) ?? 0;
      const nw = e.rank ?? 0;
      topEvts.push({ at: e.at, old, nw, status: e.status });
      lastRank.set(e.bid, nw);
    }
    topEvts.sort((a, b) => a.at.localeCompare(b.at));
  }
  // mania 1M club: monotone first-1M dates (same rule as the dashboard gauge)
  const onemRanked =
    R === 3
      ? firstDates(
          `b.status IN (1, 2) AND s.passed = 1
             AND COALESCE(json_extract(s.raw,'$.total_score_without_mods'), s.total_score) = 1000000`
        )
      : [];
  const onemLoved =
    R === 3
      ? firstDates(
          `b.status = 4 AND s.passed = 1
             AND COALESCE(json_extract(s.raw,'$.total_score_without_mods'), s.total_score) = 1000000`
        )
      : [];

  // catalog growth: how many maps existed (were ranked/loved) at each date
  const hist = db
    .prepare(
      `SELECT date(st.ranked_date) d,
         COUNT(*) total,
         SUM(CASE WHEN b.status IN (1, 2) THEN 1 ELSE 0 END) r,
         SUM(CASE WHEN b.status = 4 THEN 1 ELSE 0 END) l
       FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
       WHERE ${POOL} AND b.status IN ${STATUSES} AND st.ranked_date IS NOT NULL
       GROUP BY d ORDER BY d`
    )
    .all() as { d: string; total: number; r: number; l: number }[];

  // merge everything on the union of active days
  const dayOf = (iso: string) => iso.slice(0, 10);
  const days = [
    ...new Set([
      ...clears.map(dayOf),
      ...gradeEvents.map((e) => dayOf(e.at)),
      ...fcEvents.map((e) => dayOf(e.at)),
      ...rankedPts.map((p) => dayOf(p.at)),
      ...deltas.map((d) => dayOf(d.at)),
      ...topEvts.map((e) => dayOf(e.at)),
      ...onemRanked.map(dayOf),
      ...onemLoved.map(dayOf),
    ]),
  ].sort();

  const idx = { c: 0, cr: 0, cl: 0, g: 0, f: 0, r: 0, d: 0, h: 0, t: 0, o1: 0, o2: 0 };
  let ranked = 0;
  const catalog = { total: 0, ranked: 0, loved: 0 };
  const country = { all: 0, ranked: 0, loved: 0 };
  const fc = { all: 0, ranked: 0, loved: 0 };
  const grades = new Array(TIERS.length).fill(0) as number[];
  const gradesRanked = new Array(TIERS.length).fill(0) as number[];
  const gradesLoved = new Array(TIERS.length).fill(0) as number[];
  const TOP_TIERS = [1, 8, 15, 25, 50, 100];
  const topsRanked = new Array(TOP_TIERS.length).fill(0) as number[];
  const topsLoved = new Array(TOP_TIERS.length).fill(0) as number[];
  const advance = (arr: string[], key: "c" | "cr" | "cl" | "o1" | "o2", day: string) => {
    while (idx[key] < arr.length && dayOf(arr[idx[key]]) <= day) idx[key]++;
    return idx[key];
  };
  const points = days.map((day) => {
    const c = advance(clears, "c", day);
    const cr = advance(clearsRanked, "cr", day);
    const cl = advance(clearsLoved, "cl", day);
    while (idx.f < fcEvents.length && dayOf(fcEvents[idx.f].at) <= day) {
      const e = fcEvents[idx.f++];
      fc.all += e.delta;
      if (e.status === 4) fc.loved += e.delta;
      else fc.ranked += e.delta;
    }
    while (idx.g < gradeEvents.length && dayOf(gradeEvents[idx.g].at) <= day) {
      const e = gradeEvents[idx.g++];
      const st = e.status === 4 ? gradesLoved : gradesRanked;
      if (e.to != null) {
        grades[e.to]++;
        st[e.to]++;
      }
      if (e.from != null) {
        grades[e.from]--;
        st[e.from]--;
      }
    }
    while (idx.t < topEvts.length && dayOf(topEvts[idx.t].at) <= day) {
      const e = topEvts[idx.t++];
      const st = e.status === 4 ? topsLoved : topsRanked;
      for (let k = 0; k < TOP_TIERS.length; k++) {
        const T = TOP_TIERS[k];
        st[k] += (e.nw > 0 && e.nw <= T ? 1 : 0) - (e.old > 0 && e.old <= T ? 1 : 0);
      }
    }
    const o1 = advance(onemRanked, "o1", day);
    const o2 = advance(onemLoved, "o2", day);
    while (idx.r < rankedPts.length && dayOf(rankedPts[idx.r].at) <= day)
      ranked = rankedPts[idx.r++].total;
    while (idx.d < deltas.length && dayOf(deltas[idx.d].at) <= day) {
      const d = deltas[idx.d++];
      country.all += d.delta;
      if (d.status === 4) country.loved += d.delta;
      else country.ranked += d.delta;
    }
    while (idx.h < hist.length && hist[idx.h].d <= day) {
      catalog.total += hist[idx.h].total;
      catalog.ranked += hist[idx.h].r;
      catalog.loved += hist[idx.h].l;
      idx.h++;
    }
    return {
      day,
      total: catalog.total, totalRanked: catalog.ranked, totalLoved: catalog.loved,
      clears: c, clearsRanked: cr, clearsLoved: cl,
      fc: fc.all, fcRanked: fc.ranked, fcLoved: fc.loved,
      ranked,
      country: country.all, countryRanked: country.ranked, countryLoved: country.loved,
      grades: [...grades], // D,C,B,A,S,SH,X,XH
      gradesRanked: [...gradesRanked],
      gradesLoved: [...gradesLoved],
      topsRanked: [...topsRanked], // top 1, 8, 15, 25, 50, 100
      topsLoved: [...topsLoved],
      onemRanked: o1,
      onemLoved: o2,
    };
  });
  const payload = { tiers: TIERS, points };
  timelineCache.set(cacheKey, { version, payload });
  // each entry is ~1MB: cap like the snapshot cache
  while (timelineCache.size > 4)
    timelineCache.delete(timelineCache.keys().next().value!);
  res.json(payload);
});

/**
 * GET /api/snapshot?day=YYYY-MM-DD — per-dimension completion (star rating,
 * rank year, length, combo, AR/OD/CS/HP) at a past date, for the time-machine
 * slider. A per-map index (first clear / first FC / country transitions +
 * bucket attributes) is cached by scores version; each request is then a pure
 * in-memory aggregation (~10 ms over 150k maps).
 */
interface SnapMap {
  clear: string | null; // first clear day
  onem: string | null; // mania: first 1,000,000 day (null elsewhere)
  rankedDay: string | null; // day the map entered the catalog
  loved: boolean; // status 4 (vs ranked/approved)
  sr: number;
  /** 0.1★ slice (star_rating * 10, capped) — the skill curve's own bucket */
  q: number;
  /** basic object count, to convert a predicted standardised score to classic */
  n: number;
  year: string | null;
  len: number;
  combo: number;
  ar: number;
  od: number;
  cs: number;
  hp: number;
  /** fine buckets for the score-curve panel (index in its dimension, -1 unknown) */
  arQ: number;
  odQ: number;
  csQ: number;
  hpQ: number;
  len10: number;
  comboQ: number;
  month: number;
}
interface SnapIndex {
  version: string;
  maps: SnapMap[];
  /** country #1 transitions, aligned with maps[]: [day, held 0|1] */
  country: ([string, number][] | undefined)[];
  /** transitions of the BEST score, ALIGNED WITH maps[] (not keyed by id: the
   * snapshot walks all 150k maps per slider tick and hash lookups dominated
   * the cost): [day, gradeCode, fc_state, standardised, classic, rateBucket].
   * gradeCode: tier 0..5 = D, C, B, A, S (SH folded), SS (X/XH folded), as
   * written by the encoder below. The grade gauges follow leaderboard
   * semantics (grade OF the best), which is not monotone: an SS beaten later
   * by a higher non-SS play disappears. rateBucket is rate*10 clamped to
   * 5..20, exactly like the live histogram. */
  bests: ([string, number, number, number, number, number][] | undefined)[];
  /** global leaderboard position transitions, aligned: [day, rank | 0] */
  global: ([string, number][] | undefined)[];
  mapIds: number[];
}
// One index per (ruleset, pool): it was built for std only and cached without
// the mode, so the time machine showed osu! history on every tab.
const snapCaches = new Map<string, SnapIndex>();

function buildSnapshotIndex(
  db: ReturnType<typeof getDb>,
  R: number,
  POOL: string,
  STATUSES: string
): SnapIndex {
  // converts: per-mode SR / max combo when they have been fetched, like the
  // other views — a convert's osu! star rating means nothing in mania
  const SR = R === 0 ? "b.star_rating" : "COALESCE(ca.star_rating, b.star_rating)";
  const COMBO = R === 0 ? "b.max_combo" : "COALESCE(ca.max_combo, b.max_combo)";
  // same as /stats: mania's "CS" column is its key count
  const CS = R === 3 ? maniaKeysSql() : "b.cs";
  const caJoin =
    R === 0
      ? ""
      : `LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}`;
  // basic object count per map, as the classic-score formulas consume it:
  // std = circles+sliders+spinners, taiko/catch ~ the per-mode max combo
  const N_OBJ_SQL =
    "(COALESCE(b.count_circles,0) + COALESCE(b.count_sliders,0) + COALESCE(b.count_spinners,0))";
  const N_SQL =
    R === 0 || R === 3 ? N_OBJ_SQL : `COALESCE(${COMBO}, ${N_OBJ_SQL})`;
  const attrs = db
    .prepare(
      `SELECT b.id, ${SR} sr, ${N_SQL} n, b.total_length len, ${COMBO} combo,
         b.ar, b.od, ${CS} cs, b.hp, b.status status,
         strftime('%Y', st.ranked_date) year,
         date(st.ranked_date) ranked_day,
         MIN(CASE WHEN s.passed = 1 THEN s.ended_at END) clear,
         ${R === 3
           ? `MIN(CASE WHEN s.passed = 1
                AND COALESCE(json_extract(s.raw,'$.total_score_without_mods'), s.total_score) = 1000000
                THEN s.ended_at END)`
           : "NULL"} onem
       FROM beatmaps b
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       ${caJoin}
       LEFT JOIN scores s ON s.beatmap_id = b.id AND s.ruleset = ${R}
       WHERE ${POOL} AND b.status IN ${STATUSES}
       GROUP BY b.id`
    )
    .all() as {
    id: number; sr: number | null; n: number | null; len: number | null; combo: number | null;
    ar: number | null; od: number | null; cs: number | null; hp: number | null;
    year: string | null; ranked_day: string | null; status: number;
    clear: string | null; onem: string | null;
  }[];
  const cap = (v: number | null, c: number) =>
    v == null ? -1 : Math.min(Math.floor(v), c);
  const tenthQ = (v: number | null) =>
    v == null ? -1 : Math.min(Math.round(v * 10), 100);
  const maps: SnapMap[] = [];
  const mapIds: number[] = [];
  for (const a of attrs) {
    mapIds.push(a.id);
    maps.push({
      clear: a.clear ? a.clear.slice(0, 10) : null,
      onem: a.onem ? a.onem.slice(0, 10) : null,
      rankedDay: a.ranked_day,
      loved: a.status === 4,
      sr: cap(a.sr, 10),
      q: a.sr == null ? -1 : Math.min(Math.floor(a.sr * 10), CURVE_STEPS),
      n: a.n ?? 0,
      year: a.year,
      len: a.len == null ? -1 : Math.min(Math.floor(a.len / 60), 10),
      combo: a.combo == null ? -1 : Math.min(Math.floor(a.combo / 250), 10),
      ar: cap(a.ar, 10), od: cap(a.od, 10), hp: cap(a.hp, 10),
      cs: cap(a.cs, R === 3 ? 18 : 10), // mania: key count, dual stage reaches 18
      arQ: tenthQ(a.ar),
      odQ: tenthQ(a.od),
      csQ: R === 3 ? cap(a.cs, 18) : tenthQ(a.cs),
      hpQ: tenthQ(a.hp),
      len10: a.len == null ? -1 : Math.min(Math.floor(a.len / 10), 60),
      comboQ:
        a.combo == null ? -1 : Math.min(Math.floor(a.combo / comboCurveStep(R)), 100),
      month:
        a.ranked_day == null
          ? -1
          : (Number(a.ranked_day.slice(0, 4)) - 2007) * 12 +
            Number(a.ranked_day.slice(5, 7)) -
            1,
    });
  }

  // country #1 state transitions per map (same approximation as /timeline),
  // for THIS ruleset: unfiltered, they credited osu! #1s to every mode
  const events = db
    .prepare(
      `SELECT beatmap_id AS bid, event, COALESCE(score_at, at) AS at
       FROM country_events WHERE ruleset = ${R} ORDER BY COALESCE(score_at, at)`
    )
    .all() as { bid: number; event: string; at: string }[];
  // index of a beatmap id in maps[] — the per-date loops then use plain
  // array slots instead of hashing 150k ids three times per request
  const slot = new Map<number, number>();
  for (let i = 0; i < mapIds.length; i++) slot.set(mapIds[i], i);
  const country: ([string, number][] | undefined)[] = new Array(mapIds.length);
  for (const e of events) {
    const i = slot.get(e.bid);
    if (i == null) continue;
    let arr = country[i];
    if (!arr) {
      arr = country[i] = [];
      if (e.event === "lost") arr.push([e.at.slice(0, 10), 1]); // silent gain first
    }
    arr.push([e.at.slice(0, 10), e.event === "gained" ? 1 : 0]);
  }
  const held = db
    .prepare(
      `SELECT u.beatmap_id AS bid, s.ended_at AS at
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE u.country_first = 1 AND ${POOL}`
    )
    .all() as { bid: number; at: string }[];
  for (const r of held) {
    const i = slot.get(r.bid);
    if (i != null && !country[i]) country[i] = [[r.at.slice(0, 10), 1]];
  }

  // BEST-score transitions per map: replay the passed scores in order and
  // record each time the leaderboard best (highest total) changes
  const allScores = db
    .prepare(
      `SELECT s.beatmap_id AS bid, s.ended_at AS at,
              COALESCE(s.classic_total_score, s.total_score) AS total,
              s.total_score AS std,
              s.rank, s.fc_state AS fcState, s.rate
       FROM scores s WHERE s.ruleset = ${R} AND s.passed = 1
       ORDER BY s.ended_at`
    )
    .all() as {
    bid: number; at: string; total: number; std: number; rank: string;
    fcState: number; rate: number;
  }[];
  const bests: ([string, number, number, number, number, number][] | undefined)[] =
    new Array(mapIds.length);
  const bestTotal = new Map<number, number>();
  for (const sc of allScores) {
    const i = slot.get(sc.bid);
    if (i == null) continue; // score on a map outside this pool/scope
    if ((bestTotal.get(sc.bid) ?? -1) >= sc.total) continue;
    bestTotal.set(sc.bid, sc.total);
    // grade as a code (5 = SS, 4 = S+, 3 = A, 2 = B, 1 = C, 0 = D): string
    // compares per map per slider tick added up
    const g =
      sc.rank === "X" || sc.rank === "XH"
        ? 5
        : sc.rank === "S" || sc.rank === "SH"
          ? 4
          : sc.rank === "A"
            ? 3
            : sc.rank === "B"
              ? 2
              : sc.rank === "C"
                ? 1
                : 0;
    // same bucket as the live histogram: CAST(rate * 10 AS INTEGER) truncates,
    // clamped to lazer's 0.5x-2.0x range
    const rb = Math.min(Math.max(Math.floor((sc.rate ?? 1) * 10), 5), 20);
    (bests[i] ??= []).push([sc.at.slice(0, 10), g, sc.fcState, sc.std, sc.total, rb]);
  }

  // Global leaderboard position over time. The initial sweep records NO event
  // (it would flood the history), so a position with no event is dated at the
  // best score that earned it — the same approximation the country #1s use.
  const gEvents = db
    .prepare(
      `SELECT beatmap_id AS bid, at, new_rank AS rank
       FROM global_events WHERE ruleset = ${R} ORDER BY at`
    )
    .all() as { bid: number; at: string; rank: number | null }[];
  const global: ([string, number][] | undefined)[] = new Array(mapIds.length);
  for (const e of gEvents) {
    const i = slot.get(e.bid);
    if (i == null) continue;
    (global[i] ??= []).push([e.at.slice(0, 10), e.rank ?? 0]);
  }
  const heldGlobal = db
    .prepare(
      `SELECT u.beatmap_id AS bid, u.global_rank AS rank, s.ended_at AS at
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id AND u.ruleset = ${R}
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE u.global_rank IS NOT NULL AND ${POOL}`
    )
    .all() as { bid: number; rank: number; at: string }[];
  for (const r of heldGlobal) {
    const i = slot.get(r.bid);
    if (i != null && !global[i]) global[i] = [[r.at.slice(0, 10), r.rank]];
  }

  return { version: scoresVersion(), maps, country, bests, global, mapIds };
}

statsRouter.get("/snapshot", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const pool = String(req.query.pool ?? "");
  const POOL = withKeys(R, req, poolWhere(R, pool));

  const day = String(req.query.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    return res.status(400).json({ ok: false, error: "day=YYYY-MM-DD required" });
  const STATUSES = statusIn(String(req.query.scope ?? ""));
  const db = getDb();
  // canonical SQL strings as key: junk values collapse into one entry
  const snapKey = `${R}|${POOL}|${STATUSES}`;
  let snapCache = snapCaches.get(snapKey);
  if (snapCache) {
    // refresh recency (Map keeps insertion order)
    snapCaches.delete(snapKey);
    snapCaches.set(snapKey, snapCache);
  }
  if (!snapCache || snapCache.version !== scoresVersion()) {
    snapCache = buildSnapshotIndex(db, R, POOL, STATUSES);
    snapCaches.set(snapKey, snapCache);
  }
  // each entry holds ~180k map objects (tens of MB): LRU-cap instead of
  // keeping one entry per (ruleset, pool, keys, scope) combination forever
  while (snapCaches.size > 2)
    snapCaches.delete(snapCaches.keys().next().value!);

  type Agg = {
    total: number; played: number; fc: number; country: number;
    pfc: number; nonfc: number; ss: number; gradeS: number;
    gradeA: number; gradeB: number; gradeC: number; gradeD: number;
    onem: number;
    top1: number; top8: number; top15: number;
    top25: number; top50: number; top100: number;
  };
  /** what one map contributed at that date (an object beats 14 booleans) */
  type Hit = {
    inCat: boolean; played: boolean; fc: boolean; country: boolean;
    pfc: boolean; nonfc: boolean; ss: boolean; gradeS: boolean;
    gradeA: boolean; gradeB: boolean; gradeC: boolean; gradeD: boolean;
    onem: boolean;
    /** global position, 0 = none */
    rank: number;
  };
  const mkAgg = (): Agg => ({
    total: 0, played: 0, fc: 0, country: 0, pfc: 0, nonfc: 0, ss: 0,
    gradeS: 0, gradeA: 0, gradeB: 0, gradeC: 0, gradeD: 0, onem: 0,
    top1: 0, top8: 0, top15: 0, top25: 0, top50: 0, top100: 0,
  });
  const addHit = (a: Agg, h: Hit) => {
    if (h.inCat) a.total++;
    if (h.played) a.played++;
    if (h.fc) a.fc++;
    if (h.country) a.country++;
    if (h.pfc) a.pfc++;
    if (h.nonfc) a.nonfc++;
    if (h.ss) a.ss++;
    if (h.gradeS) a.gradeS++;
    if (h.gradeA) a.gradeA++;
    if (h.gradeB) a.gradeB++;
    if (h.gradeC) a.gradeC++;
    if (h.gradeD) a.gradeD++;
    if (h.onem) a.onem++;
    const r = h.rank;
    if (r > 0) {
      if (r === 1) a.top1++;
      if (r <= 8) a.top8++;
      if (r <= 15) a.top15++;
      if (r <= 25) a.top25++;
      if (r <= 50) a.top50++;
      if (r <= 100) a.top100++;
    }
  };
  const bumpArr = (a: Agg[], key: number, h: Hit) => {
    if (key >= 0 && key < a.length) addHit(a[key], h);
  };
  const { maps, country, bests, global } = snapCache;
  const n = maps.length;
  // ONE walk of the transitions per map, reused by every consumer below (the
  // gauges used to re-walk them a second time). Typed arrays: no allocation
  // churn on a request that fires per slider tick.
  const bestStd = new Float64Array(n);
  const bestClassic = new Float64Array(n);
  const fcStateAt = new Int8Array(n).fill(-1); // -1 = not played that day
  const gradeAt = new Int8Array(n); // 5 = SS, 4 = S+, 3 = A, 2 = B, 1 = C, 0 = D
  const rateAt = new Int8Array(n); // rate*10 of that best, 0 = not played
  const rankAt = new Int32Array(n);
  const c1At = new Uint8Array(n);
  // score-curve panel dimension (default sr). The SR fit is ALWAYS computed —
  // the missing estimates are defined against it — a second, display-only fit
  // is added when the panel looks along another axis.
  const curveDimSel = String(req.query.curveDim ?? "sr");
  const dimIdxOf =
    curveDimSel === "ar"
      ? (m: SnapMap) => m.arQ
      : curveDimSel === "od"
        ? (m: SnapMap) => m.odQ
        : curveDimSel === "cs"
          ? (m: SnapMap) => m.csQ
          : curveDimSel === "hp"
            ? (m: SnapMap) => m.hpQ
            : curveDimSel === "length"
              ? (m: SnapMap) => m.len10
              : curveDimSel === "combo"
                ? (m: SnapMap) => m.comboQ
                : curveDimSel === "month"
                  ? (m: SnapMap) => m.month
                  : null;
  const dimSteps = dimIdxOf ? curveDimSql(R, curveDimSel).steps : CURVE_STEPS;
  // curve samples per 0.1★ slice, reused arrays (no Map, no per-request alloc)
  const qs: number[][] = [];
  for (let q = 0; q <= CURVE_STEPS; q++) qs.push([]);
  const qs2: number[][] = [];
  if (dimIdxOf) for (let q = 0; q <= dimSteps; q++) qs2.push([]);
  for (let i = 0; i < n; i++) {
    const m = maps[i];
    if (m.clear != null && m.clear <= day) {
      const tr = bests[i];
      if (tr)
        for (let k = 0; k < tr.length; k++) {
          const t = tr[k];
          if (t[0] > day) break;
          gradeAt[i] = t[1];
          fcStateAt[i] = t[2];
          bestStd[i] = t[3];
          bestClassic[i] = t[4];
          rateAt[i] = t[5];
        }
      if (m.q >= 0 && bestStd[i] > 0) qs[m.q].push(bestStd[i]);
      if (dimIdxOf && bestStd[i] > 0) {
        const dq = dimIdxOf(m);
        if (dq >= 0 && dq <= dimSteps) qs2[dq].push(bestStd[i]);
      }
      const ct = country[i];
      if (ct)
        for (let k = 0; k < ct.length; k++) {
          if (ct[k][0] > day) break;
          c1At[i] = ct[k][1] as 0 | 1;
        }
    }
    const gt = global[i];
    if (gt)
      for (let k = 0; k < gt.length; k++) {
        if (gt[k][0] > day) break;
        rankAt[i] = gt[k][1];
      }
  }
  // The curve is RE-FITTED on those bests: comparing today's level against
  // past scores would make the historical missing meaningless.
  const byQ = new Map<number, number[]>();
  for (let q = 0; q <= CURVE_STEPS; q++) if (qs[q].length) byQ.set(q, qs[q]);
  const curve = fitSkillCurve(byQ);
  const byQ2 = new Map<number, number[]>();
  if (dimIdxOf)
    for (let q = 0; q <= dimSteps; q++) if (qs2[q].length) byQ2.set(q, qs2[q]);
  const dispCurve = dimIdxOf ? fitSkillCurve(byQ2, dimSteps) : curve;

  // Buckets are small integers: plain arrays instead of Map.get() 1.2M times
  const AGG_LEN = 19; // mania "CS" (key count) reaches 18
  const arr = (len = AGG_LEN) => Array.from({ length: len }, mkAgg);
  const dims = {
    bySr: arr(), byLen: arr(), byCombo: arr(),
    byAr: arr(), byOd: arr(), byCs: arr(), byHp: arr(),
    byRate: arr(21), // rate*10, 0.5x-2.0x
  };
  const byYear = new Map<string, Agg>(); // the only non-numeric dimension
  // hero rows (All / Ranked / Loved) need the same gauges as the dists
  const byStatus = { ranked: mkAgg(), loved: mkAgg() };
  // per-band aggregates for the historical curve panel, indexed by the
  // dimension it is looking at (SR by default)
  const curveTotal = new Int32Array(dimSteps + 1);
  const curvePlayed = new Int32Array(dimSteps + 1);
  const curveMissC = new Float64Array(dimSteps + 1);
  const curveMissW = new Float64Array(dimSteps + 1);
  let missing = 0;
  let missingClassic = 0;
  let missingWither = 0;
  // ranked score at that date, in the three units the hero shows (the card
  // only had its classic value historised, from the timeline)
  let rankedStd = 0;
  let rankedClassic = 0;
  let rankedWither = 0;
  const tops = { top1: 0, top8: 0, top15: 0, top25: 0, top50: 0, top100: 0, checked: 0 };
  const fcCounts = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const m = maps[i];
    const inCat = m.rankedDay != null && m.rankedDay <= day;
    const cleared = fcStateAt[i] >= 0;
    // best AT THAT DATE, replayed above: a higher non-FC score set LATER is
    // not in fcStateAt[i] yet, so it cannot take this FC away retroactively
    const fced = cleared && fcStateAt[i] <= 1;
    const onemd = m.onem != null && m.onem <= day;
    const rank = inCat ? rankAt[i] : 0;

    if (inCat) {
      // the panel aggregates follow the SELECTED dimension (a map with an
      // unknown SR still lands in its AR/length/... band, like the live
      // curve); the missing itself stays defined against the SR curve
      const dq = dimIdxOf ? dimIdxOf(m) : m.q;
      const inBand = dq >= 0 && dq <= dimSteps;
      if (inBand) {
        curveTotal[dq]++;
        if (cleared) curvePlayed[dq]++;
      }
      if (m.q >= 0) {
        const pred = curve[m.q].value;
        const mc = Math.max(0, classicFromStandardised(R, pred, m.n) - bestClassic[i]);
        missing += Math.max(0, pred - bestStd[i]);
        missingClassic += mc;
        if (inBand) curveMissC[dq] += mc;
        if (R === 0 && m.n > 0) {
          const mw = Math.max(0, witherScore(pred, m.n) - witherScore(bestStd[i], m.n));
          missingWither += mw;
          if (inBand) curveMissW[dq] += mw;
        }
      }
    }
    if (inCat && cleared) {
      fcCounts[fcStateAt[i]]++;
      rankedStd += bestStd[i];
      rankedClassic += bestClassic[i];
      if (R === 0 && m.n > 0) rankedWither += witherScore(bestStd[i], m.n);
    }
    if (rank > 0) {
      tops.checked++;
      if (rank === 1) tops.top1++;
      if (rank <= 8) tops.top8++;
      if (rank <= 15) tops.top15++;
      if (rank <= 25) tops.top25++;
      if (rank <= 50) tops.top50++;
      if (rank <= 100) tops.top100++;
    }

    const c1 = cleared && c1At[i] === 1;
    // (!fced is implied by !cleared now that it derives from the best)
    if (!inCat && !cleared && !c1 && rank === 0) continue;
    const h: Hit = {
      inCat, played: cleared, fc: fced, country: c1,
      pfc: cleared && fcStateAt[i] === 0,
      nonfc: cleared && !fced,
      ss: gradeAt[i] === 5,
      gradeS: gradeAt[i] === 4,
      gradeA: gradeAt[i] === 3,
      gradeB: gradeAt[i] === 2,
      gradeC: gradeAt[i] === 1,
      gradeD: cleared && gradeAt[i] === 0,
      onem: onemd,
      rank,
    };
    addHit(m.loved ? byStatus.loved : byStatus.ranked, h);
    bumpArr(dims.bySr, m.sr, h);
    bumpArr(dims.byLen, m.len, h);
    bumpArr(dims.byCombo, m.combo, h);
    bumpArr(dims.byAr, m.ar, h);
    bumpArr(dims.byOd, m.od, h);
    bumpArr(dims.byCs, m.cs, h);
    bumpArr(dims.byHp, m.hp, h);
    // a rate belongs to the SCORE: only a map WITH a best that day has one
    if (cleared && rateAt[i] > 0) bumpArr(dims.byRate, rateAt[i], h);
    if (m.year != null) {
      let a = byYear.get(m.year);
      if (!a) byYear.set(m.year, (a = mkAgg()));
      addHit(a, h);
    }
  }
  const out = (a: Agg[]) =>
    a.map((agg, bucket) => ({ bucket, ...agg })).filter((r) => r.total || r.played || r.country || r.fc);
  const outYear = () => [...byYear.entries()].map(([bucket, a]) => ({ bucket, ...a }));
  res.json({
    day,
    bySr: out(dims.bySr), byYear: outYear(), byLen: out(dims.byLen),
    byCombo: out(dims.byCombo), byAr: out(dims.byAr), byOd: out(dims.byOd),
    byCs: out(dims.byCs), byHp: out(dims.byHp), byRate: out(dims.byRate),
    byStatus: [
      { bucket: "ranked", ...byStatus.ranked },
      { bucket: "loved", ...byStatus.loved },
    ],
    fc: fcCounts.map((c, fc_state) => ({ fc_state, c })).filter((f) => f.c > 0),
    globalTops: tops,
    scoreSums: {
      lazer: Math.round(rankedStd),
      classic: Math.round(rankedClassic),
      wither: Math.round(rankedWither),
    },
    missingSums: {
      missing: Math.round(missing),
      missingClassic: Math.round(missingClassic),
      missingWither: Math.round(missingWither),
    },
    // same shape as /skill-curve, so the panel just swaps its source
    curveDim: curveDimSel,
    curve: dispCurve
      .filter((b) => curveTotal[b.q] > 0)
      .map((b) => ({
        q: b.q,
        predicted: b.value,
        raw: b.raw,
        samples: b.samples,
        inherited: b.samples < 5,
        total: curveTotal[b.q],
        played: curvePlayed[b.q],
        missingClassic: Math.round(curveMissC[b.q]),
        missingWither: Math.round(curveMissW[b.q]),
      })),
  });
});

// Compact stats for the stream overlay (?overlay=1) — polled every 5s,
// session deltas are computed client-side vs the first response.
statsRouter.get("/overlay", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const POOL = withKeys(R, req, poolWhere(R, String(req.query.pool ?? "")));
  // &scope=ranked|loved in the overlay URL: same three-way rule as the
  // dashboard (this endpoint used to hardcode all statuses)
  const STATUSES = statusIn(String(req.query.scope ?? ""));

  const GRADE_KEYS = ["XH", "X", "SH", "S", "A", "B", "C", "D"] as const;
  const gradeCols = GRADE_KEYS.map(
    (k) => `SUM(CASE WHEN s.rank = '${k}' THEN 1 ELSE 0 END) g_${k.toLowerCase()}`
  ).join(",\n        ");
  const row = getDb()
    .prepare(
      `SELECT
        COUNT(*) total_maps,
        SUM(COALESCE(u.played, 0)) clears,
        ${gradeCols},
        SUM(COALESCE(u.best_fc, 0)) fc,
        SUM(COALESCE(u.country_first, 0)) country,
        SUM(CASE WHEN u.global_rank = 1 THEN 1 ELSE 0 END) top1,
        SUM(CASE WHEN u.global_rank <= 8 THEN 1 ELSE 0 END) top8,
        SUM(CASE WHEN u.global_rank <= 15 THEN 1 ELSE 0 END) top15,
        SUM(CASE WHEN u.global_rank <= 25 THEN 1 ELSE 0 END) top25,
        SUM(CASE WHEN u.global_rank <= 50 THEN 1 ELSE 0 END) top50,
        SUM(CASE WHEN u.global_rank <= 100 THEN 1 ELSE 0 END) top100,
        COALESCE(SUM(COALESCE(s.classic_total_score, s.total_score)), 0) ranked_classic,
        ${
          // wither is a std-only proposal (its formula uses std object
          // counts): a non-zero total next to a missing of 0 on the other
          // tabs was a contradiction
          R === 0
            ? `COALESCE(SUM(CASE WHEN ${N_OBJ} > 0
          THEN ${witherSql("s.total_score")}
          ELSE s.total_score END), 0)`
            : "0"
        } ranked_wither
      FROM beatmaps b
      LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
      LEFT JOIN scores s ON s.id = u.best_lazer_score_id
      WHERE ${POOL} AND b.status IN ${STATUSES}`
    )
    .get() as Record<string, number | null> & { total_maps: number };
  const grades: Record<string, number> = {};
  for (const k of GRADE_KEYS) grades[k] = (row[`g_${k.toLowerCase()}`] as number) ?? 0;
  res.json({
    totalMaps: row.total_maps,
    clears: row.clears ?? 0,
    grades,
    fc: row.fc ?? 0,
    country: row.country ?? 0,
    globalTops: {
      top1: row.top1 ?? 0,
      top8: row.top8 ?? 0,
      top15: row.top15 ?? 0,
      top25: row.top25 ?? 0,
      top50: row.top50 ?? 0,
      top100: row.top100 ?? 0,
    },
    rankedClassic: row.ranked_classic ?? 0,
    rankedWither: row.ranked_wither ?? 0,
    // Last play OF THIS MODE. The overlay used to read the global activity
    // feed, which is not mode-tagged: a mania overlay announced osu! plays.
    lastPlay: (getDb()
      .prepare(
        `SELECT st.artist, st.title, b.version, s.rank, s.ended_at AS at
         FROM scores s
         JOIN beatmaps b ON b.id = s.beatmap_id
         JOIN beatmapsets st ON st.id = b.beatmapset_id
         WHERE s.ruleset = ${R} AND ${POOL}
         ORDER BY s.ended_at DESC LIMIT 1`
      )
      .get() ?? null) as {
      artist: string;
      title: string;
      version: string;
      rank: string;
      at: string;
    } | null,
  });
});
