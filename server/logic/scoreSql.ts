/**
 * Shared SQL expression builders (required aliases: b = beatmaps, s = best
 * score, u = beatmap_user) + the auto-calibrated skill curve.
 */
import { getDb, getStartedRulesets } from "../db/db.js";
import {
  CURVE_STEPS,
  fitSkillCurve,
  type CurveBucket,
} from "./skillCurve.js";
import { witherSql as witherSqlRaw } from "./wither.js";

// ---------- Shared SQL expressions (required aliases: b = beatmaps, s = best) ----------

const FULL_BASE = 1_000_000;

export { PP_SQL } from "./score.js";

export const N_OBJ =
  "(COALESCE(b.count_circles,0) + COALESCE(b.count_sliders,0) + COALESCE(b.count_spinners,0))";
// Max classic of a map (SS NoMod): n_objects² × 32.57 + 100000 (lazer formula)
const CLASSIC_MAX = `CASE WHEN ${N_OBJ} > 0 THEN CAST(ROUND(32.57 * ${N_OBJ} * ${N_OBJ} + 100000) AS INTEGER) ELSE ${FULL_BASE} END`;

/** standardised -> classic conversion (proportional to the map's max). */
function classicFromStd(stdExpr: string): string {
  return `CAST(ROUND(${CLASSIC_MAX} * (${stdExpr}) / ${FULL_BASE}.0) AS INTEGER)`;
}

// n for taiko/catch = the map's BASIC judgement count (what lazer feeds into
// convertStandardisedToClassic): NOT circles+sliders+spinners — in catch every
// juice-stream fruit counts, so that would underestimate marathons ~2x
// (squared in the formula). Exact when a best score exists (sum of the basic
// keys of maximum_statistics), else max_combo: exact for taiko (combo = hits),
// slight overestimate for catch (combo = fruits + large droplets, ~+10%).
export const N_BASIC = `NULLIF(
  COALESCE(json_extract(s.maximum_statistics,'$.perfect'),0)
  + COALESCE(json_extract(s.maximum_statistics,'$.great'),0)
  + COALESCE(json_extract(s.maximum_statistics,'$.good'),0)
  + COALESCE(json_extract(s.maximum_statistics,'$.ok'),0)
  + COALESCE(json_extract(s.maximum_statistics,'$.meh'),0)
  + COALESCE(json_extract(s.maximum_statistics,'$.miss'),0), 0)`;
/** Basic-judgement count as seen from a non-std ruleset (needs s + ca + b). */
const N_MODE = `COALESCE(${N_BASIC}, ca.max_combo, b.max_combo, ${N_OBJ})`;

/**
 * Per-ruleset classic conversion (ppy/osu ScoreInfoExtensions formulas).
 * mania: classic IS the standardised score.
 */
function classicFromStdRuleset(ruleset: number, stdExpr: string): string {
  switch (ruleset) {
    case 1:
      return `CAST(ROUND((1109.0 * ${N_MODE} + 100000) * (${stdExpr}) / ${FULL_BASE}.0) AS INTEGER)`;
    case 2:
      return `CAST(ROUND(pow((${stdExpr}) / ${FULL_BASE}.0 * ${N_MODE}, 2) * 21.62 + (${stdExpr}) / 10.0) AS INTEGER)`;
    case 3:
      return `CAST(ROUND(${stdExpr}) AS INTEGER)`;
    default:
      return classicFromStd(stdExpr);
  }
}

// Witherscore lives in wither.ts (pure, testable); only the default map
// expression for n is bound here, where N_OBJ is defined.
export { witherScore } from "./wither.js";
export function witherSql(stdExpr: string, nExpr: string = N_OBJ): string {
  return witherSqlRaw(stdExpr, nExpr);
}

/**
 * Realistic missing of a map: skill-curve prediction minus the current best,
 * in the requested metric (0 = nothing to grab given MY level).
 */
export function missingExprs(
  mode: "classic" | "lazer",
  ruleset = 0
): {
  predExpr: string;
  missingSql: string;
} {
  const curve = `(${skillCurveCase(ruleset)})`;
  const pred =
    mode === "classic" ? classicFromStdRuleset(ruleset, curve) : curve;
  // classic best: when classic_total_score is NULL, CONVERT the standardised
  // score instead of using it raw — subtracting a ~1M standardised value from
  // a ~20M classic prediction inflated the missing by the whole prediction
  const best =
    mode === "classic"
      ? `COALESCE(s.classic_total_score, ${classicFromStdRuleset(ruleset, "s.total_score")}, 0)`
      : "COALESCE(s.total_score, 0)";
  return { predExpr: pred, missingSql: `MAX(0, ${pred} - ${best})` };
}

/** Realistic missing in wither (standardised fallback if object count unknown). */
function witherMissingSql(): string {
  const pred = `(${skillCurveCase()})`;
  return `CASE WHEN ${N_OBJ} > 0
    THEN MAX(0, ${witherSql(pred)} - ${witherSql("COALESCE(s.total_score, 0)")})
    ELSE MAX(0, ${pred} - COALESCE(s.total_score, 0)) END`;
}

// ---------- Materialized missing (beatmap_user.missing_*) ----------
// The prediction is a ~100-branch CASE: evaluating it per row on every /table
// request made filtering feel sluggish. Instead it is materialized into
// beatmap_user and refreshed only when scores change or the curve cache rolls
// over (one ~1s UPDATE instead of seconds on every request).

let missingStamp = "";

// In-memory version of the scores table: a counter bumped by every writer
// (single-process, so exact), seeded from a DB scan once per restart — that
// seed still catches offline edits. Nearly every read endpoint calls this,
// several times per page load and per slider tick.
let scoresStamp: string | null = null;
let scoresBump = 0;

export function scoresVersion(): string {
  if (scoresStamp == null) {
    const v = getDb()
      .prepare(
        "SELECT COUNT(*) c, COALESCE(MAX(id), 0) m, TOTAL(pp) p FROM scores"
      )
      .get() as { c: number; m: number; p: number };
    scoresStamp = `${v.c}-${v.m}-${v.p.toFixed(3)}`;
  }
  return `${scoresStamp}-${scoresBump}`;
}

/** Call after ANY write to the scores table (insert, delete, pp/fc update). */
export function bumpScoresVersion(): void {
  scoresBump++;
}

export function ensureMissingFresh(): void {
  const db = getDb();
  const modes = getStartedRulesets();
  const untils = modes.map((r) => computeSkillCurve(r).until).join("/");
  const stamp = `${scoresVersion()}-${untils}-${modes.join(",")}`;
  if (stamp === missingStamp) return;

  for (const R of modes) {
    // every pool map needs a row to carry its missing value (unplayed = full
    // prediction); harmless for the backfill, which keys off fetched_at
    const pool = R === 0 ? "b.ruleset = 0" : `(b.ruleset = ${R} OR b.ruleset = 0)`;
    db.exec(
      `INSERT OR IGNORE INTO beatmap_user (beatmap_id, ruleset)
       SELECT id, ${R} FROM beatmaps b WHERE ${pool}`
    );
    const lazer = missingExprs("lazer", R).missingSql;
    const classic = missingExprs("classic", R).missingSql;
    // wither is a std-only display; other modes keep NULL
    const wither = R === 0 ? witherMissingSql() : "NULL";
    const caJoin =
      R === 0
        ? ""
        : `LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}`;
    db.exec(
      `UPDATE beatmap_user SET
         missing_lazer = x.ml, missing_classic = x.mc, missing_wither = x.mw
       FROM (
         SELECT b.id AS bid,
           ${lazer} AS ml,
           ${classic} AS mc,
           ${wither} AS mw
         FROM beatmaps b
         LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
         ${caJoin}
         LEFT JOIN scores s ON s.id = u.best_lazer_score_id
         WHERE ${pool}
       ) AS x
       WHERE beatmap_user.beatmap_id = x.bid AND beatmap_user.ruleset = ${R}`
    );
  }
  missingStamp = stamp;
}

/**
 * Auto-calibrated skill curve: for each 0.1★ slice, the MEDIAN of my bests
 * (standardised) = the "realistic" score I can post at that difficulty.
 * No monotone fit since 1.17: the curve follows the medians wherever they go
 * (see skillCurve.ts). Gaps (< 5 bests) filled by carry-over from the left.
 * Used for the "realistic gain" = what I can still grab on a map given MY
 * level, not the theoretical max.
 */
export { CURVE_STEPS, fitSkillCurve, type CurveBucket };
const curveCaches = new Map<
  string,
  { until: number; caseSql: string; buckets: CurveBucket[] }
>();
/** SR expression of a map as seen from `ruleset` (converts: per-mode attrs). */
function curveSr(ruleset: number): string {
  return ruleset === 0
    ? "b.star_rating"
    : "COALESCE(ca.star_rating, b.star_rating)";
}
export function computeSkillCurve(
  ruleset = 0,
  statuses = "(1, 2, 4)",
  /** overrides the default pool (converts included): lets the /skill-curve
   * route calibrate on exactly the maps the dashboard is looking at */
  poolOverride?: string
): {
  until: number;
  caseSql: string;
  buckets: CurveBucket[];
} {
  const cacheKey = `${ruleset}-${statuses}-${poolOverride ?? ""}`;
  const cached = curveCaches.get(cacheKey);
  if (cached && Date.now() < cached.until) return cached;
  const db = getDb();
  const pool =
    poolOverride ??
    (ruleset === 0
      ? "b.ruleset = 0"
      : `(b.ruleset = ${ruleset} OR b.ruleset = 0)`);
  const caJoin =
    ruleset === 0
      ? ""
      : `LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${ruleset} AND b.ruleset != ${ruleset}`;
  const rows = db
    .prepare(
      `SELECT MIN(CAST(${curveSr(ruleset)} * 10 AS INTEGER), ${CURVE_STEPS}) AS q, s.total_score AS ts
       FROM beatmap_user u
       JOIN scores s ON s.id = u.best_lazer_score_id
       JOIN beatmaps b ON b.id = u.beatmap_id
       ${caJoin}
       WHERE u.ruleset = ${ruleset} AND ${pool} AND b.status IN ${statuses}
         AND ${curveSr(ruleset)} IS NOT NULL`
    )
    .all() as { q: number; ts: number }[];
  const byQ = new Map<number, number[]>();
  for (const r of rows) {
    const arr = byQ.get(r.q) ?? [];
    arr.push(r.ts);
    byQ.set(r.q, arr);
  }
  const buckets = fitSkillCurve(byQ);
  const parts = buckets.map((b) => `WHEN ${b.q} THEN ${b.value}`);
  const caseSql = `CASE MIN(CAST(${curveSr(ruleset)} * 10 AS INTEGER), ${CURVE_STEPS}) ${parts.join(" ")} ELSE ${buckets[buckets.length - 1].value} END`;
  const entry = { until: Date.now() + 10 * 60_000, caseSql, buckets };
  curveCaches.set(cacheKey, entry);
  return entry;
}
function skillCurveCase(ruleset = 0): string {
  return computeSkillCurve(ruleset).caseSql;
}


