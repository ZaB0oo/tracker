import { Router } from "express";
import { getDb } from "../db/db.js";
import { missingExprs } from "../logic/scoreSql.js";

export const tableRouter = Router();

/**
 * GET /api/table — the UI's central query (sort/filters on the SQL side, stays
 * smooth even with 150k rows; the frontend virtualizes and paginates by offset).
 *
 * Query params:
 *  mode=lazer|classic  displayed score metric
 *  sort=col:dir,col:dir  (whitelist below)
 *  offset, limit
 *  filters: played, fcState, grades, statuses, mods, srMin/Max, arMin/Max,
 *  odMin/Max, csMin/Max, hpMin/Max, lenMin/Max, yearMin/Max, comboMin/Max,
 *  accMin/Max, missingMin, q (free text artist/title/creator/version)
 */
const SORT_COLUMNS: Record<string, string> = {
  ended_at: "s.ended_at",
  score: "score_value",
  missing: "missing_value",
  missing_pct: "missing_pct",
  grade: "grade_order",
  fc_state: "s.fc_state",
  accuracy: "s.accuracy",
  pp: "s.pp",
  mod_multiplier: "mod_multiplier",
  artist: "st.artist COLLATE NOCASE",
  title: "st.title COLLATE NOCASE",
  version: "b.version COLLATE NOCASE",
  creator: "st.creator COLLATE NOCASE",
  status: "b.status",
  ranked_date: "st.ranked_date",
  total_length: "b.total_length",
  star_rating: "b.star_rating",
  ar: "b.ar",
  od: "b.od",
  cs: "b.cs",
  hp: "b.hp",
  bpm: "b.bpm",
  max_combo: "b.max_combo",
  score_combo: "s.max_combo",
};

tableRouter.get("/table", (req, res) => {
  const db = getDb();
  const q = req.query as Record<string, string | undefined>;
  const mode = q.mode === "classic" ? "classic" : "lazer";
  // classic is monotone vs standardised on a given map: same best as lazer
  const bestCol = "best_lazer_score_id";
  const scoreExpr =
    mode === "classic"
      ? "COALESCE(s.classic_total_score, s.total_score)"
      : "s.total_score";

  const { predExpr, missingSql } = missingExprs(mode);

  // defense in depth: never any graveyard/WIP diffs even if imported
  const where: string[] = ["b.ruleset = 0", "b.status IN (1, 2, 4)"];
  const params: Record<string, string | number | null> = {};

  const num = (name: string, sql: string, cmp: string) => {
    if (q[name] != null && q[name] !== "") {
      where.push(`${sql} ${cmp} @${name}`);
      params[name] = Number(q[name]);
    }
  };

  if (q.played === "played") where.push("u.played = 1");
  if (q.played === "unplayed") where.push("(u.played IS NULL OR u.played = 0)");
  if (q.fcState) {
    const states = q.fcState.split(",").map(Number).filter((n) => !Number.isNaN(n));
    if (states.length) where.push(`s.fc_state IN (${states.join(",")})`);
  }
  if (q.grades) {
    const grades = q.grades.split(",").filter((g) => /^[A-Z]{1,3}$/.test(g));
    if (grades.length)
      where.push(`s.rank IN (${grades.map((g) => `'${g}'`).join(",")})`);
  }
  if (q.statuses) {
    const sts = q.statuses.split(",").map(Number).filter((n) => !Number.isNaN(n));
    if (sts.length) where.push(`b.status IN (${sts.join(",")})`);
  }
  if (q.mods) {
    // "contains the mod" filter on the best's mods JSON
    for (const [i, m] of q.mods.split(",").entries()) {
      if (!/^[A-Z0-9]{2}$/i.test(m)) continue;
      where.push(`s.mods LIKE @mod${i}`);
      params[`mod${i}`] = `%"${m.toUpperCase()}"%`;
    }
  }
  if (q.frFirst === "1") where.push("u.fr_first = 1");
  // best's platform: native lazer (no legacy id) vs stable (converted)
  if (q.platform === "lazer") where.push("s.legacy_score_id IS NULL AND s.id IS NOT NULL");
  if (q.platform === "stable") where.push("s.legacy_score_id IS NOT NULL");
  if (q.setId != null && q.setId !== "") {
    where.push("b.beatmapset_id = @setId");
    params.setId = Number(q.setId);
  }
  if (q.q) {
    where.push(
      `(st.artist LIKE @text OR st.title LIKE @text OR st.creator LIKE @text OR b.version LIKE @text)`
    );
    params.text = `%${q.q}%`;
  }
  num("srMin", "b.star_rating", ">="); num("srMax", "b.star_rating", "<=");
  num("arMin", "b.ar", ">="); num("arMax", "b.ar", "<=");
  num("odMin", "b.od", ">="); num("odMax", "b.od", "<=");
  num("csMin", "b.cs", ">="); num("csMax", "b.cs", "<=");
  num("hpMin", "b.hp", ">="); num("hpMax", "b.hp", "<=");
  num("lenMin", "b.total_length", ">="); num("lenMax", "b.total_length", "<=");
  num("bpmMin", "b.bpm", ">="); num("bpmMax", "b.bpm", "<=");
  num("yearMin", "CAST(strftime('%Y', st.ranked_date) AS INTEGER)", ">=");
  num("yearMax", "CAST(strftime('%Y', st.ranked_date) AS INTEGER)", "<=");
  num("accMin", "s.accuracy * 100", ">="); num("accMax", "s.accuracy * 100", "<=");
  num("missingMin", missingSql, ">=");

  const sortParts: string[] = [];
  for (const part of (q.sort ?? "missing:desc").split(",")) {
    const [col, dir] = part.split(":");
    const sqlCol = SORT_COLUMNS[col];
    if (sqlCol) sortParts.push(`${sqlCol} ${dir === "asc" ? "ASC" : "DESC"} NULLS LAST`);
  }
  if (sortParts.length === 0) sortParts.push("missing_value DESC");

  const limit = Math.min(Number(q.limit ?? 100), 500);
  const offset = Math.max(Number(q.offset ?? 0), 0);

  const baseSql = `
    FROM beatmaps b
    JOIN beatmapsets st ON st.id = b.beatmapset_id
    LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
    LEFT JOIN scores s ON s.id = u.${bestCol}
    WHERE ${where.join(" AND ")}
  `;

  const rows = db
    .prepare(
      `SELECT
        b.id AS beatmap_id, b.beatmapset_id, b.version, b.status,
        b.total_length, b.bpm, b.cs, b.ar, b.od, b.hp, b.star_rating,
        b.max_combo AS map_max_combo,
        st.artist, st.title, st.creator, st.ranked_date,
        st.download_disabled AS dmca,
        s.id AS score_id, s.ended_at, s.rank AS grade, s.accuracy,
        s.max_combo AS score_max_combo, s.pp, s.mods, s.fc_state,
        ROUND(CAST(s.total_score AS REAL)
          / NULLIF(json_extract(s.raw, '$.total_score_without_mods'), 0), 2)
          AS mod_multiplier,
        s.total_score, s.classic_total_score,
        ${scoreExpr} AS score_value,
        ${missingSql} AS missing_value,
        ROUND(100.0 * ${missingSql} / NULLIF(${predExpr}, 0), 2) AS missing_pct,
        CASE s.rank WHEN 'XH' THEN 7 WHEN 'X' THEN 6 WHEN 'SH' THEN 5 WHEN 'S' THEN 4
             WHEN 'A' THEN 3 WHEN 'B' THEN 2 WHEN 'C' THEN 1 WHEN 'D' THEN 0
             ELSE -1 END AS grade_order,
        COALESCE(u.played, 0) AS played,
        COALESCE(u.any_fc, 0) AS any_fc,
        COALESCE(u.fr_first, 0) AS fr_first
      ${baseSql}
      ORDER BY ${sortParts.join(", ")}
      LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  const total = (
    db.prepare(`SELECT COUNT(*) c ${baseSql}`).get(params) as { c: number }
  ).c;

  res.json({ rows, total, mode });
});

// Detailed view of a map: metadata + ALL my scores + country events.
tableRouter.get("/map/:id", (req, res) => {
  const id = Number(req.params.id);
  const db = getDb();
  const map = db
    .prepare(
      `SELECT b.id, b.beatmapset_id, b.version, b.status, b.total_length, b.bpm,
         b.cs, b.ar, b.od, b.hp, b.star_rating, b.max_combo,
         b.count_circles, b.count_sliders, b.count_spinners,
         st.artist, st.title, st.creator, st.ranked_date,
         st.download_disabled AS dmca
       FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
       WHERE b.id = ?`
    )
    .get(id);
  if (!map) return res.status(404).json({ error: "unknown map" });
  const scores = db
    .prepare(
      `SELECT id, ended_at, rank, accuracy, max_combo, total_score,
         classic_total_score, pp, mods, fc_state, passed
       FROM scores WHERE beatmap_id = ? ORDER BY ended_at DESC`
    )
    .all(id);
  const user =
    db
      .prepare(
        `SELECT played, any_fc, fr_first, fr_checked_at, fetched_at
         FROM beatmap_user WHERE beatmap_id = ?`
      )
      .get(id) ?? null;
  const frEvents = db
    .prepare(
      `SELECT event, at, score_at, by_username
       FROM fr_first_events WHERE beatmap_id = ? ORDER BY at DESC`
    )
    .all(id);
  res.json({ map, scores, user, frEvents });
});
