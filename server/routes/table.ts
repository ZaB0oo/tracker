import { Router } from "express";
import { getDb } from "../db/db.js";
import { mapWhere, scoreWhere, type MetricParams } from "../logic/metrics.js";
import { ensureMissingFresh } from "../logic/scoreSql.js";
import { getBeatmapsByIds } from "../osu/api.js";

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
  global_rank: "u.global_rank",
};

/**
 * Builds the shared WHERE clause + params for the table filters (also used by
 * the collection export). Aliases: b = beatmaps, st = sets, u = beatmap_user,
 * s = best score.
 */
function buildFilters(
  db: ReturnType<typeof getDb>,
  q: Record<string, string | undefined>,
  missingSql: string
): { where: string[]; params: Record<string, string | number | null> } {
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
  if (q.countryFirst === "1") where.push("u.country_first = 1");
  // Global top filter: my exact position on the map's global leaderboard
  // (populated by the global tops sweep; any bound excludes unranked maps).
  num("globalTopMin", "u.global_rank", ">=");
  num("globalTopMax", "u.global_rank", "<=");
  // Missing maps of a metric: maps matching its MAP conditions whose BEST
  // score does not match its SCORE conditions (leaderboard semantics, same
  // rule as the metric evaluation; the inner alias `s` shadows the outer
  // best-score join on purpose — scoreWhere targets the subquery row).
  if (q.metricMissing != null && q.metricMissing !== "") {
    const row = db
      .prepare("SELECT params FROM metrics WHERE id = ?")
      .get(Number(q.metricMissing)) as { params: string } | undefined;
    if (row) {
      const p = JSON.parse(row.params) as MetricParams;
      where.push(mapWhere(p.map));
      where.push(
        `NOT EXISTS (SELECT 1 FROM scores s
           WHERE s.id = u.best_lazer_score_id AND ${scoreWhere(p.score)})`
      );
    }
  }
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
  // Full-date ranges (YYYY-MM-DD). Played dates target the best score, so a
  // played-date filter implicitly restricts to played maps.
  const date = (name: string, sql: string, cmp: string) => {
    const v = q[name];
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      where.push(`${sql} ${cmp} @${name}`);
      params[name] = v;
    }
  };
  date("rankedFrom", "date(st.ranked_date)", ">=");
  date("rankedTo", "date(st.ranked_date)", "<=");
  date("playedFrom", "date(s.ended_at)", ">=");
  date("playedTo", "date(s.ended_at)", "<=");
  num("accMin", "s.accuracy * 100", ">="); num("accMax", "s.accuracy * 100", "<=");
  num("missingMin", missingSql, ">=");
  return { where, params };
}

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

  ensureMissingFresh();
  // materialized missing + its best-derived prediction (pred = missing + best)
  const missingSql = `COALESCE(u.missing_${mode}, 0)`;
  const bestExpr =
    mode === "classic"
      ? "COALESCE(s.classic_total_score, s.total_score, 0)"
      : "COALESCE(s.total_score, 0)";
  const predExpr = `(${missingSql} + ${bestExpr})`;

  const { where, params } = buildFilters(db, q, missingSql);


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
        COALESCE(u.country_first, 0) AS country_first,
        u.global_rank
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
        `SELECT played, any_fc, country_first, country_checked_at, fetched_at,
           global_rank
         FROM beatmap_user WHERE beatmap_id = ?`
      )
      .get(id) ?? null;
  const countryEvents = db
    .prepare(
      `SELECT event, at, score_at, by_username
       FROM country_events WHERE beatmap_id = ? ORDER BY at DESC`
    )
    .all(id);
  res.json({ map, scores, user, countryEvents });
});

// ---------- Collection export (osu! legacy collection.db, importable in lazer) ----------

/** osu! binary "string": 0x0b marker + ULEB128 length + UTF-8 bytes. */
function osuString(s: string): Buffer {
  const utf8 = Buffer.from(s, "utf8");
  const len: number[] = [];
  let n = utf8.length;
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n > 0) b |= 0x80;
    len.push(b);
  } while (n > 0);
  return Buffer.concat([Buffer.from([0x0b, ...len]), utf8]);
}

/**
 * Builds a legacy collection.db buffer with one collection containing every
 * map matching the given /table filters. Maps are keyed by the .osu MD5
 * (beatmaps.checksum): missing checksums are fetched inline (50/req) up to a
 * cap — beyond that, the background enrichment fills them and the user
 * retries. Shared by the file export and the direct lazer import.
 */
export async function buildCollectionDb(
  q: Record<string, string | undefined>
): Promise<
  | { buffer: Buffer; name: string; mapCount: number }
  | { error: string; status: number }
> {
  ensureMissingFresh();
  const db = getDb();
  const mode = q.mode === "classic" ? "classic" : "lazer";
  const missingSql = `COALESCE(u.missing_${mode}, 0)`;
  const { where, params } = buildFilters(db, q, missingSql);

  const rows = db
    .prepare(
      `SELECT b.id, b.checksum
       FROM beatmaps b
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       LEFT JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE ${where.join(" AND ")}`
    )
    .all(params) as { id: number; checksum: string | null }[];
  if (rows.length === 0)
    return { error: "no map matches these filters", status: 400 };

  // fetch missing checksums inline (bounded so the request stays reasonable)
  const missing = rows.filter((r) => !r.checksum).map((r) => r.id);
  const CAP = 3000; // 60 requests ≈ 1 min at the polite rate
  if (missing.length > CAP)
    return {
      status: 400,
      error:
        `${missing.length} maps still lack their MD5 checksum (cap ${CAP} per export). ` +
        "The background enrichment is filling them in — retry later or narrow the filters.",
    };
  const md5ById = new Map(rows.filter((r) => r.checksum).map((r) => [r.id, r.checksum!]));
  const setChecksum = db.prepare("UPDATE beatmaps SET checksum = ? WHERE id = ?");
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    try {
      const maps = await getBeatmapsByIds(batch, "high");
      for (const m of maps) {
        if (m.checksum) {
          md5ById.set(m.id, m.checksum);
          setChecksum.run(m.checksum, m.id);
        }
      }
    } catch (e) {
      return { error: `checksum fetch failed: ${String(e)}`, status: 502 };
    }
  }

  const md5s = rows.map((r) => md5ById.get(r.id)).filter((x): x is string => Boolean(x));
  const name = String(q.name ?? "osu!completionist").slice(0, 120) || "osu!completionist";
  const header = Buffer.alloc(8);
  header.writeInt32LE(20220101, 0); // osu! version stamp (format is stable)
  header.writeInt32LE(1, 4); // one collection
  const count = Buffer.alloc(4);
  count.writeInt32LE(md5s.length, 0);
  const buffer = Buffer.concat([header, osuString(name), count, ...md5s.map(osuString)]);
  return { buffer, name, mapCount: md5s.length };
}

/**
 * GET /api/export-collection?name=...&<same filters as /table>
 * Downloads the collection.db (importable into osu!lazer via the direct
 * import endpoint below, or any external collection tool).
 */
tableRouter.get("/export-collection", async (req, res) => {
  const built = await buildCollectionDb(req.query as Record<string, string | undefined>);
  if ("error" in built)
    return res.status(built.status).json({ ok: false, error: built.error });

  const safe = built.name.replace(/[^\w\- ]+/g, "_");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}.db"`);
  res.send(built.buffer);
});
