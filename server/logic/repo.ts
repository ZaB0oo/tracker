import { getDb, getState, setState, transaction } from "../db/db.js";
import type { SoloScore } from "../osu/types.js";
import { computeFcState, computeRate } from "./score.js";
import { multiplierFor, type MultiplierIndex, buildMultiplierIndex } from "./modMultiplier.js";
import { bumpScoresVersion } from "./scoreSql.js";

/**
 * Insert/update a beatmap's scores and refresh the bests + played state.
 * `markFetched=false` (polling): does NOT stamp fetched_at, that stamp means
 * "complete list of scores fetched by the backfill". Without it, a score
 * submitted via polling would skip the map in the backfill and an old best
 * would stay forever on osu!'s side.
 *
 * Returns the resulting best (lazer pointer), used by the polling path for
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
  // valid reference, use the per-ruleset convert_attrs when known
  const nativeRow = db
    .prepare("SELECT ruleset, max_combo FROM beatmaps WHERE id = ?")
    .get(beatmapId) as { ruleset: number; max_combo: number | null } | undefined;
  // `|| null`: 0 is the enrichment's "API returned nothing" sentinel, as an
  // FC reference it made EVERY score a perfect FC (combo >= 0)
  let maxCombo = nativeRow?.max_combo || null;
  if (nativeRow && nativeRow.ruleset !== ruleset) {
    maxCombo =
      (
        db
          .prepare(
            "SELECT max_combo FROM convert_attrs WHERE beatmap_id = ? AND ruleset = ?"
          )
          .get(beatmapId, ruleset) as { max_combo: number | null } | undefined
      )?.max_combo || null;
  }

  const upsertScore = db.prepare(`
    INSERT INTO scores (
      id, legacy_score_id, beatmap_id, user_id, ruleset, ended_at, rank,
      accuracy, max_combo, total_score, classic_total_score, pp,
      is_perfect_combo, legacy_perfect, fc_state, mods, rate, mod_multiplier,
      statistics, maximum_statistics, passed, raw, nomod_score
    ) VALUES (
      @id, @legacy_score_id, @beatmap_id, @user_id, @ruleset, @ended_at, @rank,
      @accuracy, @max_combo, @total_score, @classic_total_score, @pp,
      @is_perfect_combo, @legacy_perfect, @fc_state, @mods, @rate, @mod_multiplier,
      @statistics, @maximum_statistics, @passed, @raw, @nomod_score
    )
    ON CONFLICT(id) DO UPDATE SET
      total_score = excluded.total_score,
      classic_total_score = excluded.classic_total_score,
      pp = excluded.pp,
      rank = excluded.rank,
      fc_state = excluded.fc_state,
      raw = excluded.raw,
      nomod_score = excluded.nomod_score
  `);

  const existsStmt = db.prepare("SELECT 1 FROM scores WHERE id = ?");
  let hasNewScore = false;

  transaction(() => {
    for (const s of scores) {
      // fails are not part of the tracker at all: never stored, so nothing
      // downstream can ever count or display them
      if (!s.passed) continue;
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
        rate: computeRate(s.mods ?? []),
        // the API only gives total_score_without_mods on modded lazer scores;
        // everything else is filled from what the other scores taught us
        mod_multiplier: multiplierFor(
          JSON.stringify(s.mods ?? []),
          multiplierIndex(db),
          directMultiplier(s)
        ),
        statistics: JSON.stringify(s.statistics ?? {}),
        maximum_statistics: s.maximum_statistics
          ? JSON.stringify(s.maximum_statistics)
          : null,
        passed: s.passed ? 1 : 0,
        raw: JSON.stringify(s),
        nomod_score:
          (s as { total_score_without_mods?: number }).total_score_without_mods ??
          null,
      });
    }
    refreshBest(beatmapId, opts?.markFetched ?? true, ruleset);
    // A never-seen score (e.g. fetched by a re-backfill after a long absence)
    // may have taken a country #1 or a global rank: re-queue BOTH checks.
    // This is the single post-score requeue; the tick's 15-min rules only
    // cover checks stamped after the score landed. (Polling re-stamps right
    // after via its immediate checks.)
    if (hasNewScore)
      db.prepare(
        "UPDATE beatmap_user SET country_checked_at = NULL, global_checked_at = NULL WHERE beatmap_id = ? AND ruleset = ?"
      ).run(beatmapId, ruleset);
  });

  bumpScoresVersion();
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
 * One-shot startup repair (state key): before v1.35.0 refreshBest picked the
 * best by CLASSIC score, which is not monotone in the standardised one on a
 * few mod combinations (Strict Tracking). Re-point every map whose stored
 * best is not the standardised winner. Bumping the key re-runs it.
 */
export function repairBestPointers(): number {
  const KEY = "best_std_repair";
  if (getState(KEY) === "v1") return 0;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.beatmap_id AS id, u.ruleset AS r
       FROM beatmap_user u JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE EXISTS (
         SELECT 1 FROM scores t
         WHERE t.beatmap_id = u.beatmap_id AND t.ruleset = u.ruleset AND t.passed = 1
           AND (t.total_score > s.total_score
                OR (t.total_score = s.total_score AND t.id < s.id)))`
    )
    .all() as { id: number; r: number }[];
  for (const { id, r } of rows) refreshBest(id, false, r);
  if (rows.length > 0) bumpScoresVersion();
  setState(KEY, "v1");
  return rows.length;
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
  // The score that "counts" for a map = the passed score with the highest
  // STANDARDISED total_score, ties on the lowest id (the rule every replay
  // and gain loop applies). Scores are per ruleset: a convert's taiko scores
  // must never feed the std best of the same beatmap (and vice versa).
  const bestLazer =
    (
      db
        .prepare(
          `SELECT id FROM scores
           WHERE beatmap_id = ? AND ruleset = ? AND passed = 1
           ORDER BY total_score DESC, id ASC LIMIT 1`
        )
        .get(beatmapId, ruleset) as { id: number } | undefined
    )?.id ?? null;

  db.prepare(
    `INSERT INTO beatmap_user (beatmap_id, ruleset, fetched_at, played, best_lazer_score_id)
     VALUES (?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, ?)
     ON CONFLICT(beatmap_id, ruleset) DO UPDATE SET
       fetched_at = COALESCE(excluded.fetched_at, beatmap_user.fetched_at),
       played = MAX(beatmap_user.played, excluded.played),
       best_lazer_score_id = excluded.best_lazer_score_id`
  ).run(beatmapId, ruleset, markFetched ? 1 : 0, bestLazer != null ? 1 : 0, bestLazer);

  // Leaderboard semantics, like the grade and the PFC/SS gauges: the flag
  // describes the score that counts on the leaderboard, so an FC beaten later
  // by a higher-scoring non-FC play stops counting. Reads the pointer the
  // INSERT above has just written. SQL twin of the backfill in db.ts.
  db.prepare(
    `UPDATE beatmap_user SET best_fc = EXISTS(
       SELECT 1 FROM scores s
       WHERE s.id = beatmap_user.best_lazer_score_id AND s.fc_state <= 1)
     WHERE beatmap_id = ? AND ruleset = ?`
  ).run(beatmapId, ruleset);
}

/**
 * Startup cleanup: deletes stored scores that osu! itself does not honor,
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
  if (deleted > 0) bumpScoresVersion();
  return { deleted, maps: ids.length };
}

/**
 * Re-evaluates the fc_state of a map's scores for one ruleset, call when the
 * FC reference arrives AFTER the scores were stored (convert_attrs filled in
 * the background): fc_state is frozen at insert time, so a convert backfilled
 * before its per-mode max_combo could never resolve to PERFECT by combo.
 */
export function recomputeFcForMap(beatmapId: number, ruleset: number): void {
  const db = getDb();
  const nativeRow = db
    .prepare("SELECT ruleset, max_combo FROM beatmaps WHERE id = ?")
    .get(beatmapId) as { ruleset: number; max_combo: number | null } | undefined;
  let maxCombo = nativeRow?.max_combo || null;
  if (nativeRow && nativeRow.ruleset !== ruleset)
    maxCombo =
      (
        db
          .prepare(
            "SELECT max_combo FROM convert_attrs WHERE beatmap_id = ? AND ruleset = ?"
          )
          .get(beatmapId, ruleset) as { max_combo: number | null } | undefined
      )?.max_combo || null;
  const rows = db
    .prepare(
      `SELECT id, fc_state, is_perfect_combo, legacy_perfect, legacy_score_id,
              max_combo, statistics
       FROM scores WHERE beatmap_id = ? AND ruleset = ?`
    )
    .all(beatmapId, ruleset) as {
    id: number; fc_state: number; is_perfect_combo: number;
    legacy_perfect: number | null; legacy_score_id: number | null;
    max_combo: number; statistics: string;
  }[];
  if (rows.length === 0) return;
  const upd = db.prepare("UPDATE scores SET fc_state = ? WHERE id = ?");
  let changed = 0;
  for (const r of rows) {
    let stats: Record<string, number> = {};
    try {
      stats = JSON.parse(r.statistics) as Record<string, number>;
    } catch {
      /* fall back to the flags */
    }
    const fc = computeFcState(
      {
        is_perfect_combo: r.is_perfect_combo === 1,
        legacy_perfect: r.legacy_perfect == null ? null : r.legacy_perfect === 1,
        legacy_score_id: r.legacy_score_id,
        max_combo: r.max_combo,
        statistics: stats,
      },
      maxCombo,
      ruleset
    );
    if (fc !== r.fc_state) {
      upd.run(fc, r.id);
      changed++;
    }
  }
  if (changed > 0) {
    refreshBest(beatmapId, false, ruleset);
    bumpScoresVersion();
  }
}

/**
 * Startup repair: maps stamped max_combo = 0 (the enrichment's "API returned
 * nothing" sentinel) made every score on them a PERFECT FC at insert time
 * (score.combo >= 0 is always true). Recompute those scores' fc_state with no
 * combo reference, the statistics-based rules still apply, then refresh the
 * affected bests/best_fc. Idempotent, no-op when nothing is wrong.
 */
export function repairZeroComboFc(): { scores: number; maps: number } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.beatmap_id, s.ruleset, s.fc_state, s.is_perfect_combo,
              s.legacy_perfect, s.legacy_score_id, s.max_combo, s.statistics
       FROM scores s JOIN beatmaps b ON b.id = s.beatmap_id
       LEFT JOIN convert_attrs ca
         ON ca.beatmap_id = s.beatmap_id AND ca.ruleset = s.ruleset
       -- native maps AND converts: the sentinel exists on both sides
       WHERE (b.ruleset = s.ruleset AND b.max_combo = 0)
          OR (b.ruleset != s.ruleset AND ca.max_combo = 0)`
    )
    .all() as {
    id: number; beatmap_id: number; ruleset: number; fc_state: number;
    is_perfect_combo: number; legacy_perfect: number | null;
    legacy_score_id: number | null; max_combo: number; statistics: string;
  }[];
  if (rows.length === 0) return { scores: 0, maps: 0 };
  const upd = db.prepare("UPDATE scores SET fc_state = ? WHERE id = ?");
  const touched = new Set<string>();
  let changed = 0;
  transaction(() => {
    for (const r of rows) {
      let stats: Record<string, number> = {};
      try {
        stats = JSON.parse(r.statistics) as Record<string, number>;
      } catch {
        /* no statistics: the state below falls back to the flags */
      }
      const fc = computeFcState(
        {
          is_perfect_combo: r.is_perfect_combo === 1,
          legacy_perfect: r.legacy_perfect == null ? null : r.legacy_perfect === 1,
          legacy_score_id: r.legacy_score_id,
          max_combo: r.max_combo,
          statistics: stats,
        },
        null, // no reliable combo reference for these maps
        r.ruleset
      );
      if (fc !== r.fc_state) {
        upd.run(fc, r.id);
        changed++;
        touched.add(`${r.beatmap_id}|${r.ruleset}`);
      }
    }
    for (const key of touched) {
      const [bid, rs] = key.split("|").map(Number);
      refreshBest(bid, false, rs);
    }
  });
  if (changed > 0) bumpScoresVersion();
  return { scores: changed, maps: touched.size };
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

/**
 * The multiplier the API let us compute for THIS score: it publishes the score
 * the play would have had without mods, but only on modded lazer scores.
 */
function directMultiplier(s: SoloScore): number | null {
  const withoutMods = (s as { total_score_without_mods?: number }).total_score_without_mods;
  if (withoutMods == null || !(withoutMods > 0)) return null;
  return Math.round((s.total_score / withoutMods) * 10000) / 10000;
}

/**
 * Mod-multiplier lookup, built once per process: it is derived from the whole
 * scores table, so rebuilding it per inserted score would be absurd. New
 * combinations that appear later are picked up by the boot backfill.
 */
let multIdx: MultiplierIndex | null = null;
function multiplierIndex(db: ReturnType<typeof getDb>): MultiplierIndex {
  return (multIdx ??= buildMultiplierIndex(db));
}
