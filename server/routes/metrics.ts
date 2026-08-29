import { Router } from "express";
import { getDb } from "../db/db.js";
import { srMods, srModsKey, type ModRef } from "../logic/score.js";
import { evalMetric, previewMetric } from "../logic/metricEval.js";
import { PP_SQL } from "../logic/scoreSql.js";
import { mapWhere, scoreWhere, type MetricParams } from "../logic/metrics.js";
import { hasOsuFile, localStarRating } from "../osu/difficulty.js";
import { parseRulesetParam, poolWhere } from "../logic/rulesets.js";
import { notifyMetricProgress } from "../notify/discord.js";

const KINDS = ["count", "ranked_score", "std_score", "pp", "total_pp"] as const;

/**
 * Parses stored metric params. Guards two things at once: a corrupt row must
 * not 500 every metrics endpoint (skip it, loudly), and `ruleset` is
 * interpolated into SQL downstream so it is coerced to 0-3 no matter what the
 * stored JSON says.
 */
function loadParams(row: { id: number; params: string }): MetricParams | null {
  try {
    const p = JSON.parse(row.params) as MetricParams;
    return { ...p, ruleset: parseRulesetParam(p.ruleset) };
  } catch (e) {
    console.error(`[metrics] metric ${row.id} has corrupt params, skipped:`, e);
    return null;
  }
}

/** Lazy background fill of the modded-SR cache, in the background. */
const srInFlight = new Set<string>();
export function queueModdedSr(
  beatmapId: number,
  mods: ModRef[],
  key: string,
  ruleset: number
): void {
  const inFlight = `${beatmapId}|${ruleset}|${key}`;
  if (srInFlight.has(inFlight)) return;
  srInFlight.add(inFlight);
  // one macrotask per calculation: the WASM computation is synchronous
  // (5-50ms) and a burst of 100 queued maps back-to-back starved every
  // pending request
  void new Promise((r) => setImmediate(r))
    .then(() => localStarRating(beatmapId, mods, ruleset))
    .then((sr) => {
      // a PERMANENT failure (file on disk but suspicious/unreadable) is
      // stored as null so the 60s refetch stops retrying it; a failed
      // DOWNLOAD is transient and must stay retryable
      if (sr == null && !hasOsuFile(beatmapId)) return;
      getDb()
        .prepare(
          "INSERT OR REPLACE INTO modded_sr (beatmap_id, ruleset, mods, star_rating) VALUES (?, ?, ?, ?)"
        )
        .run(beatmapId, ruleset, key, sr);
    })
    .finally(() => srInFlight.delete(inFlight));
}

/**
 * Decorate score rows with the star rating OF THE MODS PLAYED (`sr_mods`),
 * from the shared cache; misses are queued so the values fill within a
 * refetch or two. Rows without SR-affecting mods get null (the map rating
 * is already right).
 */
export function fillSrMods<T extends { mods: string }>(
  rows: T[],
  ruleset: number,
  idOf: (r: T) => number
): (T & { sr_mods: number | null })[] {
  const get = getDb().prepare(
    "SELECT star_rating FROM modded_sr WHERE beatmap_id = ? AND ruleset = ? AND mods = ?"
  );
  return rows.map((r) => {
    const played = r.mods ? srMods(r.mods) : [];
    if (played.length === 0) return { ...r, sr_mods: null };
    const key = srModsKey(played);
    const hit = get.get(idOf(r), ruleset, key) as
      | { star_rating: number | null }
      | undefined;
    if (!hit) queueModdedSr(idOf(r), played, key, ruleset);
    return { ...r, sr_mods: hit?.star_rating ?? null };
  });
}

// Custom metrics (milestones + evolution)
export const metricsRouter = Router();

// Real maxima of the catalog, used as slider bounds in the metric builder
// (instead of arbitrary caps / ∞). Loved maps are excluded: their broken SR /
// BPM outliers would stretch the sliders into uselessness.
metricsRouter.get("/metrics/filter-bounds", (req, res) => {
  const db = getDb();
  const R = parseRulesetParam(req.query.ruleset);
  const pool = R === 0 ? "b.ruleset = 0" : `(b.ruleset = ${R} OR b.ruleset = 0)`;
  const caJoin =
    R === 0
      ? ""
      : `LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}`;
  const srX = R === 0 ? "b.star_rating" : "COALESCE(ca.star_rating, b.star_rating)";
  const comboX = R === 0 ? "b.max_combo" : "COALESCE(ca.max_combo, b.max_combo)";
  const b = db
    .prepare(
      `SELECT MAX(${srX}) sr, MAX(b.total_length) len, MAX(${comboX}) combo,
         MAX(b.bpm) bpm
       FROM beatmaps b ${caJoin} WHERE ${pool} AND b.status IN (1, 2)`
    )
    .get() as { sr: number | null; len: number | null; combo: number | null; bpm: number | null };
  const yr = db
    .prepare(
      `SELECT MIN(strftime('%Y', ranked_date)) y FROM beatmapsets
       WHERE ranked_date IS NOT NULL AND status IN (1, 2)`
    )
    .get() as { y: string | null };
  const g = db
    .prepare(`SELECT MAX(global_rank) r FROM beatmap_user WHERE ruleset = ${R}`)
    .get() as { r: number | null };
  const pp = db
    .prepare(`SELECT MAX(pp) p, MAX(total_score) std FROM scores WHERE ruleset = ${R}`)
    .get() as { p: number | null; std: number | null };
  res.json({
    sr: b.sr,
    len: b.len,
    combo: b.combo,
    bpm: b.bpm,
    yearMin: yr.y != null ? Number(yr.y) : null,
    globalMax: g.r,
    pp: pp.p,
    stdMax: pp.std,
  });
});

metricsRouter.get("/metrics", (req, res) => {
  const db = getDb();
  const gran = req.query.granularity === "day" ? "day" : "month";
  const rows = db
    .prepare("SELECT id, name, params FROM metrics ORDER BY sort_order, id")
    .all() as { id: number; name: string; params: string }[];
  res.json({
    metrics: rows.flatMap((r) => {
      const params = loadParams(r);
      if (!params) return [];
      return [{ id: r.id, name: r.name, params, ...evalMetric(params, gran) }];
    }),
  });
});

// Lean values for the stream overlay (polled every 5 s): name + current count
// only. evalMetric is cached by params+scores-version, so repeat calls are free
// until a new score arrives.
metricsRouter.get("/overlay-metrics", (req, res) => {
  const ids = String(req.query.ids ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return res.json({ metrics: [] });
  const rows = getDb()
    .prepare(
      `SELECT id, name, params FROM metrics
       WHERE id IN (${ids.join(",")}) ORDER BY sort_order, id`
    )
    .all() as { id: number; name: string; params: string }[];
  // Total (and %) are only meaningful when the metric restricts its map pool:
  // for "all maps" metrics the total is just the whole catalog — noise on
  // stream. total: 0 tells the overlay to hide it. Compared against the catalog
  // OF THE METRIC'S OWN mode and pool, not always std's.
  const catalogTotal = (ruleset: number, pool?: string) =>
    (
      getDb()
        .prepare(
          `SELECT COUNT(*) c FROM beatmaps b
           WHERE ${poolWhere(ruleset, pool)} AND b.status IN (1, 2, 4)`
        )
        .get() as { c: number }
    ).c;
  res.json({
    metrics: rows.flatMap((r) => {
      const params = loadParams(r);
      if (!params) return [];
      const { count, total } = evalMetric(params, "month");
      const whole = catalogTotal(params.ruleset ?? 0, params.pool);
      return [{
        id: r.id,
        name: r.name,
        kind: params.kind,
        ruleset: params.ruleset ?? 0,
        // countdown: the overlay colors a DECREASE as progress
        descending: params.kind === "count" && params.descending === true,
        count,
        total: total !== whole ? total : 0,
      }];
    }),
  });
});

// Live preview for the builder: count + per-star-rating breakdown, unsaved.
metricsRouter.post("/metrics/preview", (req, res) => {
  // same guards as the save routes: an unvalidated step of 0 would spin
  // the milestone builder forever and hang the process
  const p = req.body as MetricParams | undefined;
  if (!p || !KINDS.includes(p.kind) || !(Number(p.step) > 0))
    return res.status(400).json({ ok: false, error: "invalid metric" });
  try {
    res.json(previewMetric(p));
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

metricsRouter.post("/metrics", (req, res) => {
  const body = req.body as { name?: unknown; params?: MetricParams };
  const name = String(body.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "name required" });
  const params = body.params;
  if (!params || !KINDS.includes(params.kind))
    return res.status(400).json({ ok: false, error: "invalid metric" });
  if (!(Number(params.step) > 0))
    return res.status(400).json({ ok: false, error: "invalid step" });
  if (params.stepPct === true && params.kind !== "count")
    return res
      .status(400)
      .json({ ok: false, error: "percent steps are for count metrics" });
  if (params.stepPct === true && !(Number(params.step) <= 100))
    return res.status(400).json({ ok: false, error: "invalid step (1-100%)" });
  try {
    previewMetric(params); // validates the conditions compile
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
  const order =
    (getDb().prepare("SELECT COALESCE(MAX(sort_order), 0) m FROM metrics").get() as {
      m: number;
    }).m + 1;
  getDb()
    .prepare("INSERT INTO metrics (name, params, sort_order) VALUES (?, ?, ?)")
    .run(name, JSON.stringify(params), order);
  res.json({ ok: true });
});

metricsRouter.put("/metrics/:id", (req, res) => {
  const id = Number(req.params.id);
  const body = req.body as { name?: unknown; params?: MetricParams };
  const name = String(body.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "name required" });
  const params = body.params;
  if (!params || !KINDS.includes(params.kind))
    return res.status(400).json({ ok: false, error: "invalid metric" });
  if (!(Number(params.step) > 0))
    return res.status(400).json({ ok: false, error: "invalid step" });
  if (params.stepPct === true && params.kind !== "count")
    return res
      .status(400)
      .json({ ok: false, error: "percent steps are for count metrics" });
  if (params.stepPct === true && !(Number(params.step) <= 100))
    return res.status(400).json({ ok: false, error: "invalid step (1-100%)" });
  try {
    previewMetric(params);
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
  getDb()
    .prepare("UPDATE metrics SET name = ?, params = ? WHERE id = ?")
    .run(name, JSON.stringify(params), id);
  res.json({ ok: true });
});

// Display order: the full id list in the desired order.
metricsRouter.post("/metrics/reorder", (req, res) => {
  const ids = (req.body as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n)))
    return res.status(400).json({ ok: false, error: "ids must be integers" });
  const db = getDb();
  const upd = db.prepare("UPDATE metrics SET sort_order = ? WHERE id = ?");
  ids.forEach((id, i) => upd.run(i + 1, id));
  res.json({ ok: true });
});

// "Post progress" button: one embed with the metric's current state and next
// milestone, behind a shared server-side cooldown (spam-proof by design).
metricsRouter.post("/metrics/:id/discord", (req, res) => {
  // conds: the card's one-line condition summary, shown as the embed footer
  const conds = (req.body as { conds?: unknown } | undefined)?.conds;
  const error = notifyMetricProgress(
    Number(req.params.id),
    typeof conds === "string" && conds.trim() !== "" ? conds : undefined
  );
  if (error) return res.status(429).json({ ok: false, error });
  res.json({ ok: true });
});

metricsRouter.delete("/metrics/:id", (req, res) => {
  getDb().prepare("DELETE FROM metrics WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

/**
 * Top pp plays of a pp metric, CUMULATIVE from the beginning up to the end
 * of the given period (YYYY-MM or YYYY-MM-DD) — "my top plays as of then".
 * One score per map, the metric's map/score conditions applied.
 */
metricsRouter.get("/metrics/:id/pp-top", (req, res) => {
  const id = Number(req.params.id);
  const period = String(req.query.period ?? "");
  const isDay = /^\d{4}-\d{2}-\d{2}$/.test(period);
  if (!isDay && !/^\d{4}-\d{2}$/.test(period))
    return res
      .status(400)
      .json({ ok: false, error: "period must be YYYY-MM or YYYY-MM-DD" });
  const row = getDb()
    .prepare("SELECT params FROM metrics WHERE id = ?")
    .get(id) as { params: string } | undefined;
  if (!row) return res.status(404).json({ ok: false, error: "unknown metric" });
  const p = loadParams({ id, params: row.params });
  if (!p) return res.status(500).json({ ok: false, error: "corrupt metric params" });
  const bound = isDay
    ? "date(s.ended_at) <= @period"
    : "strftime('%Y-%m', s.ended_at) <= @period";
  const rows = getDb()
    .prepare(
      `SELECT s.beatmap_id, MAX(${PP_SQL}) AS pp, s.rank, s.accuracy, s.mods,
         s.ended_at, b.version, b.star_rating, st.artist, st.title
       FROM scores s
       JOIN beatmaps b ON b.id = s.beatmap_id
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${p.ruleset ?? 0}
       WHERE s.ruleset = ${p.ruleset ?? 0}
         AND ${mapWhere(p.map, { ruleset: p.ruleset ?? 0, pool: p.pool, keys: p.keys })} AND ${scoreWhere(p.score)}
         AND ${PP_SQL} IS NOT NULL AND s.passed = 1 AND ${bound}
       GROUP BY s.beatmap_id
       ORDER BY pp DESC
       LIMIT 100`
    )
    .all({ period }) as (Record<string, unknown> & {
    beatmap_id: number;
    mods: string;
  })[];
  // modded star rating from the cache; misses are fetched in the background
  // and show up on the next refetch
  const R = p.ruleset ?? 0;
  const cached = getDb().prepare(
    "SELECT star_rating FROM modded_sr WHERE beatmap_id = ? AND ruleset = ? AND mods = ?"
  );
  const out = rows.map((r) => {
    let acronyms: string[] = [];
    try {
      // CL kept: it affects pp (no slider acc → lower pp)
      acronyms = (JSON.parse(r.mods) as { acronym?: string }[])
        .map((m) => m.acronym ?? "")
        .filter(Boolean);
    } catch {
      // ignore, treated as nomod
    }
    // settings included: the cached value must belong to the rate played
    const diff = srMods(r.mods);
    let sr: number | null = null;
    if (diff.length > 0) {
      const key = srModsKey(diff);
      const hit = cached.get(r.beatmap_id, R, key) as
        | { star_rating: number | null }
        | undefined;
      if (hit) sr = hit.star_rating;
      else queueModdedSr(r.beatmap_id, diff, key, R);
    }
    return { ...r, mods_list: acronyms, sr_mods: sr };
  });
  res.json({ rows: out });
});
