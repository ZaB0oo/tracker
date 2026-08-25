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
  /** classic score gained by the passes (retries all count: it is activity) */
  classic: number;
  maxPp: number | null;
}

/** Pool + mania keys + scope condition of the request (shared by both routes). */
function sessionWhere(req: { query: Record<string, unknown> }, R: number): string {
  let pool = poolWhere(R, String(req.query.pool ?? ""));
  const keys = keysWhere(R, req.query.keys ? String(req.query.keys) : undefined);
  if (keys) pool = `${pool} AND ${keys}`;
  const statuses = statusIn(String(req.query.scope ?? ""));
  return `s.ruleset = ${R} AND ${pool} AND b.status IN ${statuses}`;
}

// One full scores scan per (ruleset, pool, keys, scope): cached by scores
// version like /records, thrown away as soon as a new score lands. The whole
// list ships (a few thousand compact rows, gzipped): sorting, filtering and
// paging happen client-side, instantly.
const sessionsCache = new Map<string, { version: string; payload: unknown }>();

/**
 * GET /api/sessions — play sessions reconstructed from the score timestamps:
 * consecutive plays (fails included) split whenever more than an hour passes
 * between two of them. All-time, so the client dims it under the time machine.
 */
sessionsRouter.get("/sessions", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const WHERE = sessionWhere(req, R);
  const gapMin = gapMinutes(req);
  const GAP_MS = gapMin * 60_000;
  const version = `${scoresVersion()}|pp${ppLocalVersion()}`;
  const cacheKey = `${WHERE}|${gapMin}`;
  const hit = sessionsCache.get(cacheKey);
  if (hit && hit.version === version) return res.json(hit.payload);

  const rows = getDb()
    .prepare(
      `SELECT s.ended_at AS at, ${PP_SQL} AS pp,
         b.total_length / COALESCE(s.rate, 1) AS len,
         CASE WHEN s.passed = 1
           THEN COALESCE(s.classic_total_score, s.total_score) ELSE 0
         END AS classic
       FROM scores s
       JOIN beatmaps b ON b.id = s.beatmap_id
       WHERE ${WHERE}
       ORDER BY s.ended_at`
    )
    .all() as {
    at: string;
    pp: number | null;
    len: number | null;
    classic: number;
  }[];

  const sessions: Session[] = [];
  // real seconds spent in maps (each pass at its rate) — the session `sec`
  // is wall-clock and includes the short pauses
  let playSec = 0;
  let cur: (Session & { endMs: number }) | null = null;
  for (const r of rows) {
    playSec += Math.round(r.len ?? 0);
    const t = Date.parse(r.at);
    if (cur == null || t - cur.endMs > GAP_MS) {
      cur = {
        start: r.at, end: r.at, endMs: t,
        sec: Math.round(r.len ?? 0),
        plays: 0, classic: 0, maxPp: null,
      };
      sessions.push(cur);
    } else {
      cur.sec += Math.round((t - cur.endMs) / 1000);
      cur.end = r.at;
      cur.endMs = t;
    }
    cur.plays++;
    cur.classic += r.classic;
    if (r.pp != null && (cur.maxPp == null || r.pp > cur.maxPp)) cur.maxPp = r.pp;
  }

  let longestSec = 0;
  let totalSec = 0;
  let totalPlays = 0;
  for (const s of sessions) {
    longestSec = Math.max(longestSec, s.sec);
    totalSec += s.sec;
    totalPlays += s.plays;
  }
  const payload = {
    gapMin,
    summary: {
      count: sessions.length,
      longestSec,
      avgSec: sessions.length ? totalSec / sessions.length : 0,
      avgPlays: sessions.length ? totalPlays / sessions.length : 0,
      totalSec,
      playSec,
    },
    // latest first; endMs was bookkeeping, not payload
    sessions: sessions
      .reverse()
      .map(({ start, end, sec, plays, classic, maxPp }) => ({
        start, end, sec, plays, classic, maxPp,
      })),
  };
  sessionsCache.set(cacheKey, { version, payload });
  while (sessionsCache.size > 16)
    sessionsCache.delete(sessionsCache.keys().next().value!);
  res.json(payload);
});

/**
 * GET /api/sessions/scores — every score of one session (bounds from the
 * /sessions list), map identity included, for the detail panel. Small enough
 * (one sitting) to skip caching.
 */
sessionsRouter.get("/sessions/scores", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const start = String(req.query.start ?? "");
  const end = String(req.query.end ?? "");
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)))
    return res.status(400).json({ error: "invalid session bounds" });
  const SR = R === 0 ? "b.star_rating" : "COALESCE(ca.star_rating, b.star_rating)";
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
         st.artist, st.title, b.version AS diff
       FROM scores s
       JOIN beatmaps b ON b.id = s.beatmap_id
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       ${CA}
       WHERE ${sessionWhere(req, R)} AND s.ended_at BETWEEN ? AND ?
       ORDER BY s.ended_at`
    )
    .all(start, end) as ({ mapId: number; mods: string } & Record<string, unknown>)[];
  // star rating of the mods played, from the shared cache (misses queued)
  res.json({ scores: fillSrMods(scores, R, (r) => r.mapId) });
});
