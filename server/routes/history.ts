import { Router } from "express";
import { getDb } from "../db/db.js";

export const historyRouter = Router();

/**
 * GET /api/clears — history of ALL my scores (not just the bests),
 * newest to oldest.
 */
historyRouter.get("/clears", (req, res) => {
  const db = getDb();
  const q = req.query as Record<string, string | undefined>;
  const limit = Math.min(Number(q.limit ?? 100), 500);
  const offset = Math.max(Number(q.offset ?? 0), 0);
  // Optional day filter (heatmap day card): one row per map, the day's best
  // (classic) play on it, oldest first.
  const day = q.day && /^\d{4}-\d{2}-\d{2}$/.test(q.day) ? q.day : null;

  if (day) {
    const rows = db
      .prepare(
        `SELECT s.id, s.ended_at, s.rank, s.accuracy, s.total_score,
          s.classic_total_score, s.mods, s.fc_state, s.pp,
          s.beatmap_id, b.version, b.star_rating, st.artist, st.title
         FROM scores s
         JOIN beatmaps b ON b.id = s.beatmap_id
         JOIN beatmapsets st ON st.id = b.beatmapset_id
         WHERE date(s.ended_at) = @day AND s.id = (
           SELECT s2.id FROM scores s2
           WHERE s2.beatmap_id = s.beatmap_id AND date(s2.ended_at) = @day
           ORDER BY COALESCE(s2.classic_total_score, s2.total_score) DESC
           LIMIT 1)
         ORDER BY s.ended_at
         LIMIT @limit OFFSET @offset`
      )
      .all({ day, limit, offset });
    const total = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT beatmap_id) c FROM scores WHERE date(ended_at) = ?"
        )
        .get(day) as { c: number }
    ).c;
    return res.json({ rows, total });
  }

  const rows = db
    .prepare(
      `SELECT s.id, s.ended_at, s.rank, s.accuracy, s.total_score,
        s.classic_total_score, s.mods, s.fc_state, s.pp,
        s.beatmap_id, b.version, b.star_rating, st.artist, st.title
       FROM scores s
       JOIN beatmaps b ON b.id = s.beatmap_id
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       ORDER BY s.ended_at DESC, s.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  const total = (db.prepare("SELECT COUNT(*) c FROM scores").get() as { c: number }).c;
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
  const where = ev ? `WHERE e.event = '${ev}'` : "";
  const limit = Math.min(Number(q.limit ?? 100), 500);
  const offset = Math.max(Number(q.offset ?? 0), 0);

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
    .all(limit, offset);
  const total = (
    db.prepare(`SELECT COUNT(*) c FROM country_events e ${where}`).get() as {
      c: number;
    }
  ).c;
  res.json({ rows, total });
});
