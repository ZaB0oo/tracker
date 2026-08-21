import { Router } from "express";
import { getDb } from "../db/db.js";
import { hitCountExpr, mapWhere, scoreWhere, type MetricParams } from "../logic/metrics.js";
import { ensureMissingFresh } from "../logic/scoreSql.js";
import { keysWhere, maniaKeysSql, parseRulesetParam, poolWhere } from "../logic/rulesets.js";
import { parseLengthSeconds, parseSearch, parseStatus } from "../logic/searchQuery.js";
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
 *  accMin/Max, classicMin/Max, stdMin/Max, missingMin/Max, multMin/Max,
 *  q (free text artist/title/creator/version)
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
  mod_multiplier: "s.mod_multiplier",
  rate: "s.rate",
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
  const ruleset = parseRulesetParam(q.ruleset);
  // converts: per-mode SR / max combo from convert_attrs when fetched
  const SR = ruleset === 0 ? "b.star_rating" : "COALESCE(ca.star_rating, b.star_rating)";
  const COMBO = ruleset === 0 ? "b.max_combo" : "COALESCE(ca.max_combo, b.max_combo)";
  // defense in depth: never any graveyard/WIP diffs even if imported
  const where: string[] = [poolWhere(ruleset, q.pool), "b.status IN (1, 2, 4)"];
  const params: Record<string, string | number | null> = {};

  // mania key-count filter ("4,7,other")
  const keys = keysWhere(ruleset, q.keys);
  if (keys) where.push(keys);

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
    // "contains the mod" filter on the best's mods JSON; NM = no mods
    // (CL alone still counts as nomod)
    for (const [i, m] of q.mods.split(",").entries()) {
      if (m.toUpperCase() === "NM") {
        where.push(
          `NOT EXISTS (SELECT 1 FROM json_each(s.mods) je WHERE json_extract(je.value,'$.acronym') <> 'CL')`
        );
        continue;
      }
      if (!/^[A-Z0-9]{2,3}$/i.test(m)) continue;
      where.push(`s.mods LIKE @mod${i}`);
      params[`mod${i}`] = `%"${m.toUpperCase()}"%`;
    }
  }
  // mania 1M club: at least one perfect 1,000,000 play on the map.
  // Mania-only concept: on another tab the filter is ignored instead of
  // silently emptying the table with a ruleset-3 EXISTS.
  if (q.oneMillion === "1" && ruleset === 3)
    where.push(`EXISTS (SELECT 1 FROM scores s2 WHERE s2.beatmap_id = b.id
      AND s2.ruleset = 3 AND s2.passed = 1
      AND COALESCE(s2.nomod_score, s2.total_score) = 1000000)`);
  if (q.countryFirst === "1") where.push("u.country_first = 1");
  // Global top filter: my exact position on the map's global leaderboard
  // (populated by the global tops sweep; any bound excludes unranked maps).
  num("globalTopMin", "u.global_rank", ">=");
  num("globalTopMax", "u.global_rank", "<=");
  // playback rate of the best (0.5x-2.0x): any bound implies a played map
  num("rateMin", "s.rate", ">=");
  num("rateMax", "s.rate", "<=");
  // Score of the best, in BOTH units: the mode toggle picks the displayed
  // column, filtering on the other one has to stay possible. Same expression
  // as that column, so what you filter is what you read. Any bound implies a
  // played map — s is NULL otherwise, and no comparison against NULL is true.
  const CLASSIC = "COALESCE(s.classic_total_score, s.total_score)";
  num("classicMin", CLASSIC, ">="); num("classicMax", CLASSIC, "<=");
  num("stdMin", "s.total_score", ">="); num("stdMax", "s.total_score", "<=");
  // mod multiplier of the best. Left NULL on the scores whose combination the
  // multiplier index could not resolve: a bound excludes those, like any other
  // score-derived statistic that was never determined.
  num("multMin", "s.mod_multiplier", ">="); num("multMax", "s.mod_multiplier", "<=");
  // Maps of one or more metrics (metricMissing=3 or metricMissing=3,7,9): maps
  // matching a metric's MAP conditions whose BEST score does not match its
  // SCORE conditions — the missing maps (leaderboard semantics, same rule as
  // the metric evaluation; the inner alias `s` shadows the outer best-score
  // join on purpose — scoreWhere targets the subquery row).
  //
  // Several ids = UNION: a map is listed as soon as it is left to do for AT
  // LEAST ONE of them ("what is left for these goals"). Each metric keeps its
  // own map conditions, pool and direction inside its own term, so mixing a
  // countdown with a normal metric works without the caller saying anything.
  if (q.metricMissing != null && q.metricMissing !== "") {
    const ids = q.metricMissing
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isInteger(v) && v > 0)
      .slice(0, 20); // a URL cannot turn into an unbounded query builder
    const terms: string[] = [];
    for (const id of ids) {
      const row = db.prepare("SELECT params FROM metrics WHERE id = ?").get(id) as
        | { params: string }
        | undefined;
      let p: MetricParams | null = null;
      try {
        if (row) p = JSON.parse(row.params) as MetricParams;
      } catch {
        p = null; // corrupt metric params: ignore this one
      }
      if (!p) continue;
      // interpolated into SQL below: coerce whatever the stored JSON says
      p = { ...p, ruleset: parseRulesetParam(p.ruleset) };
      // goal-mode countdown (invert): its "matching" maps are the played maps
      // whose best FAILS the goal — same inverted predicate as the evaluation
      const inv = p.kind === "count" && p.descending === true && p.invert === true;
      // A countdown metric counts DOWN, so what is left to do is the maps its
      // conditions SELECT, not the ones they miss. Derived here rather than
      // taken from the query: with several metrics the direction is per metric
      // (the legacy metricMatching=1 param still forces it, for old links).
      const matching =
        q.metricMatching === "1" ||
        (p.kind === "count" && p.descending === true);
      terms.push(
        `(${mapWhere(p.map, { ruleset: p.ruleset ?? 0, pool: p.pool, keys: p.keys })}
          AND ${matching ? "EXISTS" : "NOT EXISTS"} (SELECT 1 FROM scores s
            WHERE s.id = u.best_lazer_score_id AND ${scoreWhere(p.score, inv)}))`
      );
    }
    // every id was unknown/corrupt: filter on nothing rather than on everything
    if (ids.length > 0) where.push(terms.length ? `(${terms.join(" OR ")})` : "0");
  }
  // best's platform: native lazer (no legacy id) vs stable (converted)
  if (q.platform === "lazer") where.push("s.legacy_score_id IS NULL AND s.id IS NOT NULL");
  if (q.platform === "stable") where.push("s.legacy_score_id IS NOT NULL");
  if (q.setId != null && q.setId !== "") {
    where.push("b.beatmapset_id = @setId");
    params.setId = Number(q.setId);
  }
  if (q.q) {
    // osu!-style tokens (ar>9, status=r, keys=7, creator=…): constraints out
    // of the search box, exactly like the in-game search. Leftover = text.
    const { text, conds } = parseSearch(q.q);
    let ti = 0;
    for (const c of conds) {
      const OPS = ["=", "<", ">", "<=", ">="];
      if (!OPS.includes(c.op)) continue;
      const pn = `tok${ti++}`;
      switch (c.key) {
        case "star": case "ar": case "od": case "cs": case "hp":
        case "bpm": case "combo": case "length": {
          const expr = ({
            star: SR, ar: "b.ar", od: "b.od",
            cs: ruleset === 3 ? maniaKeysSql() : "b.cs", hp: "b.hp",
            bpm: "b.bpm", combo: COMBO, length: "b.total_length",
          } as Record<string, string>)[c.key];
          const v = c.key === "length" ? parseLengthSeconds(c.value) : Number(c.value);
          if (Number.isFinite(v)) {
            where.push(`${expr} ${c.op} @${pn}`);
            params[pn] = v;
          }
          break;
        }
        case "rate": {
          const v = Number(c.value);
          if (Number.isFinite(v)) {
            where.push(`s.rate ${c.op} @${pn}`);
            params[pn] = v;
          }
          break;
        }
        case "keys": {
          const v = Number(c.value);
          if (Number.isFinite(v)) {
            where.push(`${maniaKeysSql()} ${c.op} @${pn}`);
            params[pn] = v;
          }
          break;
        }
        case "status": {
          const v = parseStatus(c.value);
          if (v != null) where.push(`b.status = ${v}`);
          break;
        }
        case "year": {
          where.push(`CAST(strftime('%Y', st.ranked_date) AS INTEGER) ${c.op} @${pn}`);
          params[pn] = Number(c.value) || 0;
          break;
        }
        case "creator": case "artist": case "title": {
          const col = ({ creator: "st.creator", artist: "st.artist", title: "st.title" } as Record<string, string>)[c.key];
          where.push(`${col} LIKE @${pn}`);
          params[pn] = `%${c.value}%`;
          break;
        }
        case "pack": {
          // maps of an official pack, by tag (pack=S100) — needs the pack
          // definitions imported (Dashboard → Packs)
          where.push(
            `EXISTS (SELECT 1 FROM pack_sets ps
              WHERE ps.beatmapset_id = b.beatmapset_id AND ps.tag = @${pn} COLLATE NOCASE)`
          );
          params[pn] = c.value;
          break;
        }
      }
    }
    if (text) {
      // a digits-only leftover is most likely a beatmap/beatmapset id: match
      // it directly too (titles made of digits still hit the LIKE branch)
      if (/^\d+$/.test(text)) {
        where.push(
          `(b.id = @textId OR b.beatmapset_id = @textId
            OR st.artist LIKE @text OR st.title LIKE @text
            OR st.creator LIKE @text OR b.version LIKE @text)`
        );
        params.textId = Number(text);
        params.text = `%${text}%`;
      } else {
        where.push(
          `(st.artist LIKE @text OR st.title LIKE @text OR st.creator LIKE @text OR b.version LIKE @text)`
        );
        params.text = `%${text}%`;
      }
    }
  }
  num("srMin", SR, ">="); num("srMax", SR, "<=");
  num("arMin", "b.ar", ">="); num("arMax", "b.ar", "<=");
  num("odMin", "b.od", ">="); num("odMax", "b.od", "<=");
  // in mania "CS" IS the key count: filter on the same expression the column
  // displays, so a convert is never matched on its std circle size
  const CS = ruleset === 3 ? maniaKeysSql() : "b.cs";
  num("csMin", CS, ">="); num("csMax", CS, "<=");
  num("hpMin", "b.hp", ">="); num("hpMax", "b.hp", "<=");
  num("lenMin", "b.total_length", ">="); num("lenMax", "b.total_length", "<=");
  // max combo: convert-aware like the column and the dashboard buckets
  num("comboMin", COMBO, ">="); num("comboMax", COMBO, "<=");
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
  // realistic missing, in the displayed unit (missing_classic / missing_lazer),
  // exactly like the Missing column. Unplayed maps carry their full prediction
  // here, so they DO match a lower bound — that is the point of the column.
  num("missingMin", missingSql, ">="); num("missingMax", missingSql, "<=");
  // Hit counts of the best score, per ruleset (300s/100s/misses, droplets,
  // missed slider ends…): {"miss":{"max":0},"ok":{"min":1,"max":5}}. Same
  // expressions as the metric conditions (hitCountExpr), so "1x100" means the
  // same thing in both places.
  //
  // These are properties OF A SCORE, and two different things can be absent:
  //  - the statistic key, inside a score that exists (a play with no 50 has no
  //    "meh" key at all) — that is what the COALESCE(…, 0) in hitCountExpr is
  //    for, and it is right: that score really did zero 50s;
  //  - the score itself, on a map never played — where the same COALESCE would
  //    otherwise invent a flawless play out of nothing.
  // Hence the explicit guard below. It is the same semantics as the accuracy
  // filter, which excludes unplayed maps for free (NULL comparisons are never
  // true); only the COALESCE hides it here.
  if (q.hits) {
    let h: Record<string, { min?: unknown; max?: unknown }> | null = null;
    try {
      const parsed: unknown = JSON.parse(q.hits);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        h = parsed as Record<string, { min?: unknown; max?: unknown }>;
    } catch {
      h = null; // hand-edited URL: ignore rather than 500
    }
    let bounded = false;
    for (const [key, r] of Object.entries(h ?? {})) {
      const expr = hitCountExpr(key);
      if (!expr || !r || typeof r !== "object") continue;
      for (const [bound, cmp] of [["min", ">="], ["max", "<="]] as const) {
        const v = Number(r[bound]);
        if (r[bound] === "" || r[bound] == null || !Number.isFinite(v)) continue;
        where.push(`${expr} ${cmp} ${Math.trunc(v)}`);
        bounded = true;
      }
    }
    // `s` is the best score, and refreshBest only ever picks among passed
    // scores — so this says "I have a pass here", exactly what the metric
    // conditions mean with their own `s.passed = 1`.
    if (bounded) where.push("s.id IS NOT NULL");
  }
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
  const R = parseRulesetParam(q.ruleset);
  // converts: per-mode SR / max combo from convert_attrs when fetched
  const SRX = R === 0 ? "b.star_rating" : "COALESCE(ca.star_rating, b.star_rating)";
  const COMBOX = R === 0 ? "b.max_combo" : "COALESCE(ca.max_combo, b.max_combo)";
  const CSX = R === 3 ? maniaKeysSql() : "b.cs";

  const { where, params } = buildFilters(db, q, missingSql);

  const sortParts: string[] = [];
  for (const part of (q.sort ?? "missing:desc").split(",")) {
    const [col, dir] = part.split(":");
    let sqlCol = SORT_COLUMNS[col];
    if (sqlCol === "b.star_rating") sqlCol = SRX;
    if (sqlCol === "b.max_combo") sqlCol = COMBOX;
    if (sqlCol === "b.cs") sqlCol = CSX;
    if (sqlCol) sortParts.push(`${sqlCol} ${dir === "asc" ? "ASC" : "DESC"} NULLS LAST`);
  }
  if (sortParts.length === 0) sortParts.push("missing_value DESC");

  // clamp BOTH ends: limit=-1 is "unlimited" in SQLite (150k-row responses),
  // and NaN would throw at bind time
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const baseSql = `
    FROM beatmaps b
    JOIN beatmapsets st ON st.id = b.beatmapset_id
    LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
    LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}
    LEFT JOIN scores s ON s.id = u.${bestCol}
    WHERE ${where.join(" AND ")}
  `;

  const rows = db
    .prepare(
      `SELECT
        b.id AS beatmap_id, b.beatmapset_id, b.version, b.status,
        b.total_length, b.bpm, ${CSX} AS cs, b.ar, b.od, b.hp,
        ${SRX} AS star_rating,
        ${COMBOX} AS map_max_combo,
        st.artist, st.title, st.creator, st.ranked_date,
        st.download_disabled AS dmca,
        s.id AS score_id, s.ended_at, s.rank AS grade, s.accuracy,
        s.max_combo AS score_max_combo, s.pp, s.mods, s.fc_state,
        s.mod_multiplier,
        s.rate AS rate,
        s.total_score, s.classic_total_score,
        ${scoreExpr} AS score_value,
        ${missingSql} AS missing_value,
        ROUND(100.0 * ${missingSql} / NULLIF(${predExpr}, 0), 2) AS missing_pct,
        CASE s.rank WHEN 'XH' THEN 7 WHEN 'X' THEN 6 WHEN 'SH' THEN 5 WHEN 'S' THEN 4
             WHEN 'A' THEN 3 WHEN 'B' THEN 2 WHEN 'C' THEN 1 WHEN 'D' THEN 0
             ELSE -1 END AS grade_order,
        COALESCE(u.played, 0) AS played,
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
  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ error: "invalid map id" });
  const db = getDb();
  const R = parseRulesetParam(req.query.ruleset);
  // convert-aware SR/combo, like the row the user clicked in /table
  const map = db
    .prepare(
      `SELECT b.id, b.beatmapset_id, b.version, b.status, b.total_length, b.bpm,
         ${R === 3 ? maniaKeysSql() : "b.cs"} AS cs,
         b.ar, b.od, b.hp,
         COALESCE(ca.star_rating, b.star_rating) AS star_rating,
         COALESCE(ca.max_combo, b.max_combo) AS max_combo,
         b.count_circles, b.count_sliders, b.count_spinners,
         st.artist, st.title, st.creator, st.ranked_date,
         st.download_disabled AS dmca
       FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}
       WHERE b.id = ?`
    )
    .get(id);
  if (!map) return res.status(404).json({ error: "unknown map" });
  const scores = db
    .prepare(
      `SELECT id, ended_at, rank, accuracy, max_combo, total_score,
         classic_total_score, pp, mods, fc_state, passed, rate, mod_multiplier
       FROM scores WHERE beatmap_id = ? AND ruleset = ? ORDER BY ended_at DESC`
    )
    .all(id, parseRulesetParam(req.query.ruleset));
  const user =
    db
      .prepare(
        `SELECT played, best_fc, country_first, country_checked_at, fetched_at,
           global_rank, best_lazer_score_id
         FROM beatmap_user WHERE beatmap_id = ? AND ruleset = ?`
      )
      .get(id, parseRulesetParam(req.query.ruleset)) ?? null;
  const countryEvents = db
    .prepare(
      `SELECT event, at, score_at, by_username
       FROM country_events WHERE beatmap_id = ? AND ruleset = ? ORDER BY at DESC`
    )
    .all(id, parseRulesetParam(req.query.ruleset));
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
  | {
      buffer: Buffer;
      name: string;
      mapCount: number;
      /** md5 -> beatmap id, lets the lazer importer remap outdated local maps */
      md5ToId: Record<string, number>;
    }
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
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${parseRulesetParam(q.ruleset)}
       LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${parseRulesetParam(q.ruleset)} AND b.ruleset != ${parseRulesetParam(q.ruleset)}
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
  const md5ToId: Record<string, number> = {};
  for (const [id, md5] of md5ById) md5ToId[md5.toLowerCase()] = id;
  return { buffer, name, mapCount: md5s.length, md5ToId };
}

/**
 * GET /api/export-collection?name=...&<same filters as /table>
 * Downloads the collection.db (importable into osu!lazer via the direct
 * import endpoint below, or any external collection tool).
 */
tableRouter.get("/export-collection", async (req, res) => {
  // async handler: Express 4 does not catch async throws — without this the
  // request would hang forever instead of answering 500
  try {
    const built = await buildCollectionDb(req.query as Record<string, string | undefined>);
    if ("error" in built)
      return res.status(built.status).json({ ok: false, error: built.error });

    const safe = built.name.replace(/[^\w\- ]+/g, "_");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.db"`);
    res.send(built.buffer);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});
