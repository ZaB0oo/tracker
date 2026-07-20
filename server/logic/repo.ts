import { getDb, transaction } from "../db/db.js";
import type { SoloScore } from "../osu/types.js";
import { computeFcState, legacyMetric } from "./score.js";

/**
 * Insert/update a beatmap's scores and refresh the bests + played state.
 * `markFetched=false` (polling): does NOT stamp fetched_at — that stamp means
 * "complete list of scores fetched by the backfill". Without it, a score
 * submitted via polling would skip the map in the backfill and an old best
 * would stay forever on osu!'s side.
 */
export function saveScores(
  beatmapId: number,
  scores: SoloScore[],
  opts?: { markFetched?: boolean }
): void {
  const db = getDb();
  const maxCombo = (
    db.prepare("SELECT max_combo FROM beatmaps WHERE id = ?").get(beatmapId) as
      | { max_combo: number | null }
      | undefined
  )?.max_combo ?? null;

  const upsertScore = db.prepare(`
    INSERT INTO scores (
      id, legacy_score_id, beatmap_id, user_id, ruleset, ended_at, rank,
      accuracy, max_combo, total_score, classic_total_score, legacy_total_score, pp,
      is_perfect_combo, legacy_perfect, fc_state, mods, statistics,
      maximum_statistics, passed, raw
    ) VALUES (
      @id, @legacy_score_id, @beatmap_id, @user_id, @ruleset, @ended_at, @rank,
      @accuracy, @max_combo, @total_score, @classic_total_score, @legacy_total_score, @pp,
      @is_perfect_combo, @legacy_perfect, @fc_state, @mods, @statistics,
      @maximum_statistics, @passed, @raw
    )
    ON CONFLICT(id) DO UPDATE SET
      total_score = excluded.total_score,
      classic_total_score = excluded.classic_total_score,
      legacy_total_score = excluded.legacy_total_score,
      pp = excluded.pp,
      rank = excluded.rank,
      fc_state = excluded.fc_state,
      raw = excluded.raw
  `);

  const existsStmt = db.prepare("SELECT 1 FROM scores WHERE id = ?");
  let hasNewScore = false;

  transaction(() => {
    for (const s of scores) {
      if (!existsStmt.get(s.id)) hasNewScore = true;
      const fcState = computeFcState(s, maxCombo);
      upsertScore.run({
        id: s.id,
        legacy_score_id: s.legacy_score_id ?? null,
        beatmap_id: beatmapId,
        user_id: s.user_id,
        ruleset: s.ruleset_id ?? 0,
        ended_at: s.ended_at,
        rank: s.rank,
        accuracy: s.accuracy,
        max_combo: s.max_combo,
        total_score: s.total_score,
        classic_total_score: s.classic_total_score ?? null,
        legacy_total_score: s.legacy_total_score ?? null,
        pp: s.pp ?? null,
        is_perfect_combo: s.is_perfect_combo ? 1 : 0,
        legacy_perfect:
          s.legacy_perfect == null ? null : s.legacy_perfect ? 1 : 0,
        fc_state: fcState,
        mods: JSON.stringify(s.mods ?? []),
        statistics: JSON.stringify(s.statistics ?? {}),
        maximum_statistics: s.maximum_statistics
          ? JSON.stringify(s.maximum_statistics)
          : null,
        passed: s.passed ? 1 : 0,
        raw: JSON.stringify(s),
      });
    }
    refreshBest(beatmapId, opts?.markFetched ?? true);
    // A never-seen score (e.g. fetched by a re-backfill after a long absence)
    // may have taken a country #1: we re-queue the country check.
    // (Polling re-stamps right after via its immediate check.)
    if (hasNewScore)
      db.prepare(
        "UPDATE beatmap_user SET country_checked_at = NULL WHERE beatmap_id = ?"
      ).run(beatmapId);
  });
}

/**
 * Recompute the best_lazer/best_legacy pointers from the scores table.
 * `markFetched=false`: preserves the existing fetched_at state (NULL included).
 */
export function refreshBest(beatmapId: number, markFetched = true): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, total_score, classic_total_score, legacy_total_score FROM scores
       WHERE beatmap_id = ? AND passed = 1`
    )
    .all(beatmapId) as {
    id: number;
    total_score: number;
    classic_total_score: number | null;
    legacy_total_score: number | null;
  }[];

  // The score that "counts" for a map = the one with the highest CLASSIC
  // (the tracker's main metric), even if its grade is worse.
  let bestLazer: number | null = null;
  let bestLazerVal = -1;
  let bestLegacy: number | null = null;
  let bestLegacyVal = -1;
  for (const r of rows) {
    const v = r.classic_total_score ?? r.total_score;
    if (v > bestLazerVal) {
      bestLazerVal = v;
      bestLazer = r.id;
    }
    const lv = legacyMetric(r);
    if (lv > bestLegacyVal) {
      bestLegacyVal = lv;
      bestLegacy = r.id;
    }
  }

  db.prepare(
    `INSERT INTO beatmap_user (beatmap_id, fetched_at, played, best_lazer_score_id, best_legacy_score_id)
     VALUES (?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, ?, ?)
     ON CONFLICT(beatmap_id) DO UPDATE SET
       fetched_at = COALESCE(excluded.fetched_at, beatmap_user.fetched_at),
       played = MAX(beatmap_user.played, excluded.played),
       best_lazer_score_id = excluded.best_lazer_score_id,
       best_legacy_score_id = excluded.best_legacy_score_id`
  ).run(
    beatmapId,
    markFetched ? 1 : 0,
    rows.length > 0 ? 1 : 0,
    bestLazer,
    bestLegacy
  );

  db.prepare(
    `UPDATE beatmap_user SET any_fc = EXISTS(
       SELECT 1 FROM scores s WHERE s.beatmap_id = ? AND s.passed = 1 AND s.fc_state <= 1)
     WHERE beatmap_id = ?`
  ).run(beatmapId, beatmapId);
}

/** Mark a map as fetched with no score (never played). */
export function markFetchedEmpty(beatmapId: number): void {
  getDb()
    .prepare(
      `INSERT INTO beatmap_user (beatmap_id, fetched_at, played)
       VALUES (?, datetime('now'), 0)
       ON CONFLICT(beatmap_id) DO UPDATE SET fetched_at = excluded.fetched_at`
    )
    .run(beatmapId);
}
