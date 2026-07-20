import { Router } from "express";
import { getDb } from "../db/db.js";
import {
  CURVE_STEPS,
  N_OBJ,
  computeSkillCurve,
  missingExprs,
  witherMissingSql,
  witherSql,
} from "../logic/scoreSql.js";

export const statsRouter = Router();

statsRouter.get("/stats", (_req, res) => {
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
      SUM(COALESCE(u.any_fc, 0)) fc,
      SUM(CASE WHEN b.status IN (1, 2) THEN COALESCE(u.any_fc, 0) ELSE 0 END) fc_ranked,
      SUM(CASE WHEN b.status = 4 THEN COALESCE(u.any_fc, 0) ELSE 0 END) fc_loved
    FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
    WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)`);

  const scoreSums = one<{
    lazer: number;
    classic: number;
    wither: number;
  }>(`
    SELECT
      COALESCE(SUM(s.total_score), 0) lazer,
      COALESCE(SUM(COALESCE(s.classic_total_score, s.total_score)), 0) classic,
      COALESCE(SUM(CASE WHEN ${N_OBJ} > 0
        THEN ${witherSql("s.total_score")}
        ELSE s.total_score END), 0) wither
    FROM beatmap_user u
    JOIN beatmaps b ON b.id = u.beatmap_id
    LEFT JOIN scores s ON s.id = u.best_lazer_score_id
    WHERE u.played = 1`);

  // Total realistic missing over the WHOLE catalog: unplayed maps count for
  // their full prediction.
  const missingSums = one<{
    missing: number;
    missingClassic: number;
    missingWither: number;
  }>(`
    SELECT
      COALESCE(SUM(${missingExprs("lazer").missingSql}), 0) missing,
      COALESCE(SUM(${missingExprs("classic").missingSql}), 0) missingClassic,
      COALESCE(SUM(${witherMissingSql()}), 0) missingWither
    FROM beatmaps b
    LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
    LEFT JOIN scores s ON s.id = u.best_lazer_score_id
    WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)`);

  // osu! leaderboard semantics: the map's grade/FC state = that of the score
  // that counts on the LB, i.e. the BEST by score (not the best grade).
  const grades = db
    .prepare(
      `SELECT s.rank AS grade, COUNT(*) c
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)
       GROUP BY s.rank`
    )
    .all();

  const fc = db
    .prepare(
      `SELECT s.fc_state, COUNT(*) c
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)
       GROUP BY s.fc_state`
    )
    .all();

  const bySr = db
    .prepare(
      `SELECT MIN(CAST(b.star_rating AS INTEGER), 10) sr,
        COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
        SUM(COALESCE(u.country_first, 0)) country,
        SUM(COALESCE(u.any_fc, 0)) fc
       FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND b.star_rating IS NOT NULL
       GROUP BY sr ORDER BY sr`
    )
    .all();

  const byYear = db
    .prepare(
      `SELECT strftime('%Y', st.ranked_date) year,
        COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
        SUM(COALESCE(u.country_first, 0)) country,
        SUM(COALESCE(u.any_fc, 0)) fc
       FROM beatmaps b
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       WHERE b.ruleset = 0 AND st.ranked_date IS NOT NULL
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
          SUM(COALESCE(u.any_fc, 0)) fc
         FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
         WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND ${expr} IS NOT NULL
         GROUP BY bucket ORDER BY bucket`
      )
      .all();

  const byAr = dist("b.ar", 10);
  const byOd = dist("b.od", 10);
  const byHp = dist("b.hp", 10);
  const byCs = dist("b.cs", 10);
  const byLen = dist("b.total_length / 60", 10); // one-minute buckets
  const byCombo = dist("b.max_combo / 250", 8); // buckets of 250, 2000+

  res.json({
    totals, scoreSums: { ...scoreSums, ...missingSums }, grades, fc, bySr, byYear,
    byAr, byOd, byHp, byCs, byLen, byCombo,
  });
});

/**
 * GET /api/skill-curve — skill curve detail per 0.1★ slice: retained
 * prediction, number of bests backing it (inherited slice if < 5), maps in the
 * slice and cumulative realistic missing (standardised).
 */
statsRouter.get("/skill-curve", (_req, res) => {
  const db = getDb();
  const { buckets } = computeSkillCurve();
  const aggs = db
    .prepare(
      `SELECT MIN(CAST(b.star_rating * 10 AS INTEGER), ${CURVE_STEPS}) AS q,
        COUNT(*) total,
        SUM(COALESCE(u.played, 0)) played,
        SUM(${missingExprs("classic").missingSql}) missing_classic,
        SUM(${witherMissingSql()}) missing_wither
       FROM beatmaps b
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       LEFT JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND b.star_rating IS NOT NULL
       GROUP BY q ORDER BY q`
    )
    .all() as {
    q: number;
    total: number;
    played: number | null;
    missing_classic: number | null;
    missing_wither: number | null;
  }[];
  const byQ = new Map(aggs.map((a) => [a.q, a]));
  res.json({
    buckets: buckets
      .filter((b) => (byQ.get(b.q)?.total ?? 0) > 0)
      .map((b) => {
        const a = byQ.get(b.q)!;
        return {
          sr: b.q / 10,
          predicted: b.value,
          samples: b.samples,
          inherited: b.samples < 5, // not enough bests => carried-over value
          total: a.total,
          played: a.played ?? 0,
          missingClassic: a.missing_classic ?? 0,
          missingWither: a.missing_wither ?? 0,
        };
      }),
  });
});

// Compact stats for the stream overlay (?overlay=1) — polled every 5s,
// session deltas are computed client-side vs the first response.
statsRouter.get("/overlay", (_req, res) => {
  const row = getDb()
    .prepare(
      `SELECT
        COUNT(*) total_maps,
        SUM(COALESCE(u.played, 0)) clears,
        SUM(CASE WHEN s.rank IN ('S','SH','X','XH') THEN 1 ELSE 0 END) s_count,
        SUM(COALESCE(u.any_fc, 0)) fc,
        SUM(COALESCE(u.country_first, 0)) country,
        COALESCE(SUM(COALESCE(s.classic_total_score, s.total_score)), 0) ranked_classic,
        COALESCE(SUM(CASE WHEN ${N_OBJ} > 0
          THEN ${witherSql("s.total_score")}
          ELSE s.total_score END), 0) ranked_wither
      FROM beatmaps b
      LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
      LEFT JOIN scores s ON s.id = u.best_lazer_score_id
      WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)`
    )
    .get() as {
    total_maps: number;
    clears: number | null;
    s_count: number | null;
    fc: number | null;
    country: number | null;
    ranked_classic: number;
    ranked_wither: number;
  };
  res.json({
    totalMaps: row.total_maps,
    clears: row.clears ?? 0,
    s: row.s_count ?? 0,
    fc: row.fc ?? 0,
    country: row.country ?? 0,
    rankedClassic: row.ranked_classic,
    rankedWither: row.ranked_wither,
  });
});
