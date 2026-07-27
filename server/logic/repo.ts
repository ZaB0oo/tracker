import { getDb, transaction } from "../db/db.js";
import type { SoloScore } from "../osu/types.js";
import { computeFcState } from "./score.js";

/**
 * Insert/update a beatmap's scores and refresh the bests + played state.
 * `markFetched=false` (polling): does NOT stamp fetched_at — that stamp means
 * "complete list of scores fetched by the backfill". Without it, a score
 * submitted via polling would skip the map in the backfill and an old best
 * would stay forever on osu!'s side.
 *
 * Returns the resulting best (lazer pointer) — used by the polling path for
 * Discord notifications (other callers ignore the return value).
 */
export function saveScores(
  beatmapId: number,
  scores: SoloScore[],
  opts?: { markFetched?: boolean; ruleset?: number }
): { bestScoreId: number | null } {
  const ruleset = opts?.ruleset ?? 0;
  const db = getDb();
  // convert plays (ruleset != map's mode): the map's own max_combo is not a
  // valid reference — use the per-ruleset convert_attrs when known
  const nativeRow = db
    .prepare("SELECT ruleset, max_combo FROM beatmaps WHERE id = ?")
    .get(beatmapId) as { ruleset: number; max_combo: number | null } | undefined;
  let maxCombo = nativeRow?.max_combo ?? null;
  if (nativeRow && nativeRow.ruleset !== ruleset) {
    maxCombo =
      (
        db
          .prepare(
            "SELECT max_combo FROM convert_attrs WHERE beatmap_id = ? AND ruleset = ?"
          )
          .get(beatmapId, ruleset) as { max_combo: number | null } | undefined
      )?.max_combo ?? null;
  }

  const upsertScore = db.prepare(`
    INSERT INTO scores (
      id, legacy_score_id, beatmap_id, user_id, ruleset, ended_at, rank,
      accuracy, max_combo, total_score, classic_total_score, pp,
      is_perfect_combo, legacy_perfect, fc_state, mods, statistics,
      maximum_statistics, passed, raw
    ) VALUES (
      @id, @legacy_score_id, @beatmap_id, @user_id, @ruleset, @ended_at, @rank,
      @accuracy, @max_combo, @total_score, @classic_total_score, @pp,
      @is_perfect_combo, @legacy_perfect, @fc_state, @mods, @statistics,
      @maximum_statistics, @passed, @raw
    )
    ON CONFLICT(id) DO UPDATE SET
      total_score = excluded.total_score,
      classic_total_score = excluded.classic_total_score,
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
      const fcState = computeFcState(s, maxCombo, s.ruleset_id ?? ruleset);
      upsertScore.run({
        id: s.id,
        legacy_score_id: s.legacy_score_id ?? null,
        beatmap_id: beatmapId,
        user_id: s.user_id,
        ruleset: s.ruleset_id ?? ruleset,
        ended_at: s.ended_at,
        rank: s.rank,
        accuracy: s.accuracy,
        max_combo: s.max_combo,
        total_score: s.total_score,
        classic_total_score: s.classic_total_score ?? null,
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
    refreshBest(beatmapId, opts?.markFetched ?? true, ruleset);
    // A never-seen score (e.g. fetched by a re-backfill after a long absence)
    // may have taken a country #1: we re-queue the country check.
    // (Polling re-stamps right after via its immediate check.)
    if (hasNewScore)
      db.prepare(
        "UPDATE beatmap_user SET country_checked_at = NULL WHERE beatmap_id = ? AND ruleset = ?"
      ).run(beatmapId, ruleset);
  });

  const after = db
    .prepare(
      "SELECT best_lazer_score_id FROM beatmap_user WHERE beatmap_id = ? AND ruleset = ?"
    )
    .get(beatmapId, ruleset) as
    | { best_lazer_score_id: number | null }
    | undefined;
  return { bestScoreId: after?.best_lazer_score_id ?? null };
}

/**
 * Recompute the best pointer from the scores table.
 * `markFetched=false`: preserves the existing fetched_at state (NULL included).
 */
export function refreshBest(
  beatmapId: number,
  markFetched = true,
  ruleset = 0
): void {
  const db = getDb();
  // scores are per ruleset: a convert's taiko scores must never feed the
  // std best of the same beatmap (and vice versa)
  const rows = db
    .prepare(
      `SELECT id, total_score, classic_total_score FROM scores
       WHERE beatmap_id = ? AND ruleset = ? AND passed = 1`
    )
    .all(beatmapId, ruleset) as {
    id: number;
    total_score: number;
    classic_total_score: number | null;
  }[];

  // The score that "counts" for a map = the one with the highest CLASSIC
  // (the tracker's main metric), even if its grade is worse.
  let bestLazer: number | null = null;
  let bestLazerVal = -1;
  for (const r of rows) {
    const v = r.classic_total_score ?? r.total_score;
    if (v > bestLazerVal) {
      bestLazerVal = v;
      bestLazer = r.id;
    }
  }

  db.prepare(
    `INSERT INTO beatmap_user (beatmap_id, ruleset, fetched_at, played, best_lazer_score_id)
     VALUES (?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, ?)
     ON CONFLICT(beatmap_id, ruleset) DO UPDATE SET
       fetched_at = COALESCE(excluded.fetched_at, beatmap_user.fetched_at),
       played = MAX(beatmap_user.played, excluded.played),
       best_lazer_score_id = excluded.best_lazer_score_id`
  ).run(beatmapId, ruleset, markFetched ? 1 : 0, rows.length > 0 ? 1 : 0, bestLazer);

  db.prepare(
    `UPDATE beatmap_user SET any_fc = EXISTS(
       SELECT 1 FROM scores s
       WHERE s.beatmap_id = ? AND s.ruleset = ? AND s.passed = 1 AND s.fc_state <= 1)
     WHERE beatmap_id = ? AND ruleset = ?`
  ).run(beatmapId, ruleset, beatmapId, ruleset);
}

/**
 * Startup cleanup: deletes stored scores that osu! itself does not honor —
 * scores on maps outside ranked/approved/loved, and scores set BEFORE the
 * map's leaderboard existed (played while graveyard, ranked/loved later:
 * osu! wipes those, the map must be replayed). Bests/played are then
 * recomputed for the affected maps. Idempotent and cheap when clean.
 */
export function cleanupPreLeaderboardScores(): { deleted: number; maps: number } {
  const db = getDb();
  // out of scope: map absent/out of the catalog (migrate() drops graveyard
  // rows but leaves their scores orphaned), or played before the leaderboard
  // existed
  const COND = `
    NOT EXISTS (
      SELECT 1 FROM beatmaps b WHERE b.id = s.beatmap_id AND b.status IN (1, 2, 4))
    OR EXISTS (
      SELECT 1 FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
      WHERE b.id = s.beatmap_id AND st.ranked_date IS NOT NULL
        AND datetime(s.ended_at) < datetime(st.ranked_date))`;
  const any = db.prepare(`SELECT 1 FROM scores s WHERE ${COND} LIMIT 1`).get();
  if (!any) return { deleted: 0, maps: 0 };
  // only refresh maps that still exist (refreshBest would otherwise create
  // orphan beatmap_user rows for deleted maps)
  const ids = db
    .prepare(
      `SELECT DISTINCT s.beatmap_id AS id, s.ruleset AS ruleset FROM scores s
       WHERE (${COND}) AND EXISTS (SELECT 1 FROM beatmaps b WHERE b.id = s.beatmap_id)`
    )
    .all() as { id: number; ruleset: number }[];

  let deleted = 0;
  transaction(() => {
    deleted = Number(
      db.prepare(`DELETE FROM scores AS s WHERE ${COND}`).run().changes
    );
    for (const r of ids) refreshBest(r.id, false, r.ruleset);
  });
  return { deleted, maps: ids.length };
}

/** Mark a map as fetched with no score (never played). */
export function markFetchedEmpty(beatmapId: number, ruleset = 0): void {
  getDb()
    .prepare(
      `INSERT INTO beatmap_user (beatmap_id, ruleset, fetched_at, played)
       VALUES (?, ?, datetime('now'), 0)
       ON CONFLICT(beatmap_id, ruleset) DO UPDATE SET fetched_at = excluded.fetched_at`
    )
    .run(beatmapId, ruleset);
}
