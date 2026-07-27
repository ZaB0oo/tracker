import { Router } from "express";
import { getDb } from "../db/db.js";
import { parseRulesetParam } from "../logic/rulesets.js";

export const historyRouter = Router();

function paging(q: Record<string, string | undefined>): {
  limit: number;
  offset: number;
} {
  return {
    limit: Math.min(Number(q.limit ?? 100), 500),
    offset: Math.max(Number(q.offset ?? 0), 0),
  };
}

const CLEARS_SELECT = `SELECT s.id, s.ended_at, s.rank, s.accuracy, s.total_score,
    s.classic_total_score, s.mods, s.fc_state, s.pp,
    s.beatmap_id, b.version, b.star_rating, st.artist, st.title
   FROM scores s
   JOIN beatmaps b ON b.id = s.beatmap_id
   JOIN beatmapsets st ON st.id = b.beatmapset_id`;

/**
 * GET /api/clears — history of ALL my scores (not just the bests),
 * newest to oldest.
 */
historyRouter.get("/clears", (req, res) => {
  const db = getDb();
  const q = req.query as Record<string, string | undefined>;
  const R = parseRulesetParam(q.ruleset);
  const { limit, offset } = paging(q);
  // Optional day filter (heatmap day card): one row per map, the day's best
  // (classic) play on it, oldest first.
  const day = q.day && /^\d{4}-\d{2}-\d{2}$/.test(q.day) ? q.day : null;

  if (day) {
    const rows = db
      .prepare(
        `${CLEARS_SELECT}
         WHERE b.status IN (1, 2, 4) AND s.ruleset = ${R}
           AND date(s.ended_at) = @day AND s.id = (
           SELECT s2.id FROM scores s2
           WHERE s2.beatmap_id = s.beatmap_id AND s2.ruleset = ${R}
             AND date(s2.ended_at) = @day
           ORDER BY COALESCE(s2.classic_total_score, s2.total_score) DESC
           LIMIT 1)
         ORDER BY s.ended_at
         LIMIT @limit OFFSET @offset`
      )
      .all({ day, limit, offset });
    const total = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT s.beatmap_id) c FROM scores s
           JOIN beatmaps b ON b.id = s.beatmap_id
           WHERE b.status IN (1, 2, 4) AND s.ruleset = ${R} AND date(s.ended_at) = ?`
        )
        .get(day) as { c: number }
    ).c;
    return res.json({ rows, total });
  }

  const rows = db
    .prepare(
      `${CLEARS_SELECT}
       WHERE b.status IN (1, 2, 4) AND s.ruleset = ${R}
       ORDER BY s.ended_at DESC, s.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM scores s
         JOIN beatmaps b ON b.id = s.beatmap_id
         WHERE b.status IN (1, 2, 4) AND s.ruleset = ${R}`
      )
      .get() as { c: number }
  ).c;
  res.json({ rows, total });
});

/**
 * GET /api/country-history — history of country #1s gained/lost.
 * Params: event=gained|lost (optional), offset, limit.
 */
historyRouter.get("/country-history", (req, res) => {
  const db = getDb();
  const q = req.query as Record<string, string | undefined>;
  const ev = q.event === "gained" || q.event === "lost" ? q.event : null;
  const where = ev ? "WHERE e.event = ?" : "";
  const evParams = ev ? [ev] : [];
  const { limit, offset } = paging(q);

  const rows = db
    .prepare(
      `SELECT e.id, e.event, e.at, e.score_at, e.by_user_id, e.by_username,
        e.beatmap_id, b.version, b.star_rating, st.artist, st.title
       FROM country_events e
       JOIN beatmaps b ON b.id = e.beatmap_id
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       ${where}
       ORDER BY e.at DESC, e.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...evParams, limit, offset);
  const total = (
    db.prepare(`SELECT COUNT(*) c FROM country_events e ${where}`).get(...evParams) as {
      c: number;
    }
  ).c;
  res.json({ rows, total });
});

/**
 * GET /api/global-history — global tops tier transitions (top 1/8/15/25/50/100).
 * Params: event=gained|lost (optional), offset, limit.
 * gained = entered a better tier (new rank smaller, or was outside before).
 */
historyRouter.get("/global-history", (req, res) => {
  const db = getDb();
  const q = req.query as Record<string, string | undefined>;
  const GAINED = "(e.new_rank IS NOT NULL AND (e.old_rank IS NULL OR e.new_rank < e.old_rank))";
  const where =
    q.event === "gained"
      ? `WHERE ${GAINED}`
      : q.event === "lost"
        ? `WHERE NOT ${GAINED}`
        : "";
  const { limit, offset } = paging(q);

  const rows = db
    .prepare(
      `SELECT e.id, e.at, e.old_rank, e.new_rank,
        e.beatmap_id, b.version, b.star_rating, st.artist, st.title
       FROM global_events e
       JOIN beatmaps b ON b.id = e.beatmap_id
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       ${where}
       ORDER BY e.at DESC, e.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  const total = (
    db.prepare(`SELECT COUNT(*) c FROM global_events e ${where}`).get() as {
      c: number;
    }
  ).c;
  res.json({ rows, total });
});
