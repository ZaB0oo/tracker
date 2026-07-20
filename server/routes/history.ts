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
