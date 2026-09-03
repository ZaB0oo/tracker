import { Router } from "express";
import { getDb } from "../db/db.js";
import { keysWhere, parseRulesetParam, poolWhere, statusIn } from "../logic/rulesets.js";
import { PP_SQL, scoresVersion } from "../logic/scoreSql.js";
import { ppLocalVersion } from "../osu/ppFill.js";
import { fillSrMods } from "./metrics.js";

export const sessionsRouter = Router();

/** Default split: plays less than an hour apart belong to the same sitting.
 * The client can pick another gap (&gap=minutes, clamped 5-120). */
const DEFAULT_GAP_MIN = 60;
function gapMinutes(req: { query: Record<string, unknown> }): number {
  const n = Number(req.query.gap);
  return Number.isFinite(n) && n > 0
    ? Math.min(120, Math.max(5, Math.round(n)))
    : DEFAULT_GAP_MIN;
}

interface Session {
  start: string;
  end: string;
  /** wall-clock seconds, first map's length included so a one-play session
   * is not zero seconds long */
  sec: number;
  plays: number;
  /** scores of the session that are the map's current best */
  bests: number;
  /** first-ever clears earned in the session */
  newClears: number;
  /** the session's best pp is a local estimate */
  maxPpEst: number;
  /** classic score gained by the passes (retries all count: it is activity) */
  classic: number;
  maxPp: number | null;
}

/** Pool + mania keys + scope condition alone (alias b), no ruleset guard. */
function scopeCond(req: { query: Record<string, unknown> }, R: number): string {
  let pool = poolWhere(R, String(req.query.pool ?? ""));
  const keys = keysWhere(R, req.query.keys ? String(req.query.keys) : undefined);
  if (keys) pool = `${pool} AND ${keys}`;
  const statuses = statusIn(String(req.query.scope ?? ""));
  return `(${pool} AND b.status IN ${statuses})`;
}

/** Full filter of the request (used by the detail route). */
function sessionWhere(req: { query: Record<string, unknown> }, R: number): string {
  return `s.ruleset = ${R} AND ${scopeCond(req, R)}`;
}

// One full scores scan per (ruleset, pool, keys, scope): cached by scores
// version like /records, thrown away as soon as a new score lands. The whole
// list ships (a few thousand compact rows, gzipped): sorting, filtering and
// paging happen client-side, instantly.
const sessionsCache = new Map<string, { version: string; payload: unknown }>();

/**
 * GET /api/sessions — play sessions reconstructed from the score timestamps:
 * consecutive plays split whenever more than an hour passes between two of
 * them. All-time, so the client dims it under the time machine.
 *
 * A sitting is a REAL-TIME notion: its bounds and duration come from the
 * mode's WHOLE activity, whatever pool or status the maps belong to. The
 * pool/keys/scope filter only decides which plays are counted and listed
 * inside each sitting (and a sitting with none of them is not shown).
 * Splitting on the filtered subset instead used to invent sessions: two
 * loved plays 90 minutes apart INSIDE one long ranked sitting became two
 * tiny "sessions" under the loved scope, with wrong counts and durations.
 */
sessionsRouter.get("/sessions", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const COND = scopeCond(req, R);
  const gapMin = gapMinutes(req);
  const GAP_MS = gapMin * 60_000;
  const version = `${scoresVersion()}|pp${ppLocalVersion()}`;
  const cacheKey = `${R}|${COND}|${gapMin}`;
  const hit = sessionsCache.get(cacheKey);
  if (hit && hit.version === version) {
    // LRU touch: re-insert so a live entry is not first in line for eviction
    sessionsCache.delete(cacheKey);
    sessionsCache.set(cacheKey, hit);
    return res.json(hit.payload);
  }

  const rows = getDb()
    .prepare(
      `SELECT s.ended_at AS at, ${PP_SQL} AS pp,
         s.beatmap_id AS bid, s.passed,
         CASE WHEN s.pp IS NULL AND s.pp_local >= 0 THEN 1 ELSE 0 END AS pp_est,
         b.total_length / COALESCE(s.rate, 1) AS len,
         CASE WHEN s.passed = 1
           THEN COALESCE(s.classic_total_score, s.total_score) ELSE 0
         END AS classic,
         CASE WHEN u.best_lazer_score_id = s.id THEN 1 ELSE 0 END AS best,
         CASE WHEN ${COND} THEN 1 ELSE 0 END AS in_scope
       FROM scores s
       JOIN beatmaps b ON b.id = s.beatmap_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = s.beatmap_id AND u.ruleset = ${R}
       WHERE s.ruleset = ${R} AND s.passed = 1
       ORDER BY s.ended_at, s.id`
    )
    .all() as {
    at: string;
    pp: number | null;
    bid: number;
    passed: number;
    pp_est: number;
    len: number | null;
    classic: number;
    best: number;
    in_scope: number;
  }[];

  const sessions: (Session & { endMs: number })[] = [];
  const clearedMaps = new Set<number>();
  // real seconds spent in the FILTERED maps (each pass at its rate) — the
  // session `sec` is wall-clock over the whole sitting, pauses included
  let playSec = 0;
  let cur: (Session & { endMs: number }) | null = null;
  for (const r of rows) {
    const t = Date.parse(r.at);
    // EVERY play of the mode advances the sitting (bounds and wall-clock),
    // scoped or not: the sitting is when he was at the game, not what for
    if (cur == null || t - cur.endMs > GAP_MS) {
      cur = {
        start: r.at, end: r.at, endMs: t,
        sec: Math.round(r.len ?? 0),
        plays: 0, bests: 0, newClears: 0, maxPpEst: 0, classic: 0, maxPp: null,
      };
      sessions.push(cur);
    } else {
      cur.sec += Math.round((t - cur.endMs) / 1000);
      cur.end = r.at;
      cur.endMs = t;
    }
    // ...but only the plays matching the pool/keys/scope filter are counted
    if (r.in_scope !== 1) continue;
    playSec += Math.round(r.len ?? 0);
    cur.plays++;
    if (r.best === 1) cur.bests++;
    // ordered scan over every score: the first pass on a map is its clear
    if (r.passed === 1 && !clearedMaps.has(r.bid)) {
      clearedMaps.add(r.bid);
      cur.newClears++;
    }
    cur.classic += r.classic;
    if (r.pp != null && (cur.maxPp == null || r.pp > cur.maxPp)) {
      cur.maxPp = r.pp;
      cur.maxPpEst = r.pp_est;
    }
  }
  // a sitting without a single play in the current scope has nothing to
  // show or count: it is not part of this view
  const kept = sessions.filter((s) => s.plays > 0);

  let longestSec = 0;
  let totalSec = 0;
  let totalPlays = 0;
  for (const s of kept) {
    longestSec = Math.max(longestSec, s.sec);
    totalSec += s.sec;
    totalPlays += s.plays;
  }
  const payload = {
    gapMin,
    summary: {
      count: kept.length,
      longestSec,
      avgSec: kept.length ? totalSec / kept.length : 0,
      avgPlays: kept.length ? totalPlays / kept.length : 0,
      totalSec,
      playSec,
    },
    // latest first; endMs was bookkeeping, not payload
    sessions: kept
      .reverse()
      .map(({ start, end, sec, plays, bests, newClears, maxPpEst, classic, maxPp }) => ({
        start, end, sec, plays, bests, newClears, maxPpEst, classic, maxPp,
      })),
  };
  sessionsCache.set(cacheKey, { version, payload });
  while (sessionsCache.size > 16)
    sessionsCache.delete(sessionsCache.keys().next().value!);
  res.json(payload);
});

/**
 * GET /api/sessions/scores — the scores of one session (bounds from the
 * /sessions list, which spans the whole sitting) matching the current
 * pool/keys/scope filter, map identity included, for the detail panel:
 * the list shows exactly the plays the session's counters counted. Small
 * enough (one sitting) to skip caching.
 */
sessionsRouter.get("/sessions/scores", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const start = String(req.query.start ?? "");
  const end = String(req.query.end ?? "");
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)))
    return res.status(400).json({ error: "invalid session bounds" });
  const SR = R === 0 ? "b.star_rating" : "COALESCE(ca.star_rating, b.star_rating)";
  const MC = R === 0 ? "b.max_combo" : "COALESCE(ca.max_combo, b.max_combo)";
  // this map's scores strictly before the row's score (same instant: lower
  // id first) — the "state of the map before this play". Ordering by the
  // standardised score: present on every row, and classic is monotone in it,
  // so the winner is the same score refreshBest picks, without scale mixing.
  const PRIOR = `s2.beatmap_id = s.beatmap_id AND s2.ruleset = ${R} AND s2.passed = 1
       AND (s2.ended_at < s.ended_at OR (s2.ended_at = s.ended_at AND s2.id < s.id))`;
  const CA =
    R === 0
      ? ""
      : `LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}`;
  const scores = getDb()
    .prepare(
      `SELECT s.id, s.beatmap_id AS mapId, s.ended_at AS at, s.rank, s.accuracy,
         s.total_score AS std, s.classic_total_score AS classic,
         ${PP_SQL} AS pp, s.mods,
         s.rate, s.fc_state, s.passed, s.max_combo AS combo,
         b.total_length / COALESCE(s.rate, 1) AS len, ${SR} AS sr,
         ${MC} AS map_max_combo,
         st.artist, st.title, b.version AS diff, b.status AS map_status,
         CASE WHEN u.best_lazer_score_id = s.id THEN 1 ELSE 0 END AS best,
         CASE WHEN s.pp IS NULL AND s.pp_local >= 0 THEN 1 ELSE 0 END AS pp_est,
         (SELECT COALESCE(s2.classic_total_score, s2.total_score)
            FROM scores s2 WHERE ${PRIOR}
            ORDER BY s2.total_score DESC, s2.id LIMIT 1) AS prev_best,
         (SELECT s2.rank FROM scores s2 WHERE ${PRIOR}
            ORDER BY s2.total_score DESC, s2.id LIMIT 1) AS prev_grade,
         (SELECT MAX(s2.total_score) FROM scores s2 WHERE ${PRIOR}) AS prev_best_std,
         (SELECT CASE WHEN s2.fc_state <= 1 THEN 1 ELSE 0 END
            FROM scores s2 WHERE ${PRIOR}
            ORDER BY s2.total_score DESC, s2.id LIMIT 1) AS prev_best_fc
       FROM scores s
       JOIN beatmaps b ON b.id = s.beatmap_id
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = s.beatmap_id AND u.ruleset = ${R}
       ${CA}
       WHERE ${sessionWhere(req, R)} AND s.passed = 1
         AND s.ended_at BETWEEN ? AND ?
       ORDER BY s.ended_at, s.id`
    )
    .all(start, end) as ({ mapId: number; mods: string } & Record<string, unknown>)[];
  // star rating of the mods played, from the shared cache (misses queued)
  res.json({ scores: fillSrMods(scores, R, (r) => r.mapId) });
});
