/**
 * Pack completion endpoints: per-category aggregates for the dashboard grid,
 * per-pack map detail for the modal, and the opt-in definitions import.
 * A pack belongs to a tab when its ruleset matches (NULL = std sets: shown on
 * the osu! tab natively, and on the other tabs as converts).
 */
import { Router } from "express";
import { config } from "../config.js";
import { getDb } from "../db/db.js";
import { keysWhere, parseRulesetParam, poolWhere, statusIn } from "../logic/rulesets.js";
import { scoresVersion } from "../logic/scoreSql.js";
import { runPacksImport } from "../sync/daemon.js";

export const packsRouter = Router();

const cache = new Map<string, { version: string; at: number; payload: unknown }>();
const TTL_MS = 60_000;
const CACHE_MAX = 32; // ?at= has one key per slider date: LRU-cap, don't grow forever

/** packs visible on this tab: native series + mode-agnostic (std-set) packs */
function packWhere(R: number): string {
  return R === 0 ? "(p.ruleset = 0 OR p.ruleset IS NULL)" : `(p.ruleset = ${R} OR p.ruleset IS NULL)`;
}

/** Map-side conditions: same pool / mania keys / scope rules as the dashboard
 * around the panel (this used to hardcode the "all" pool and every status). */
function mapScope(req: { query: Record<string, unknown> }, R: number): string {
  const pool = poolWhere(R, String(req.query.pool ?? ""));
  const keys = keysWhere(R, typeof req.query.keys === "string" ? req.query.keys : undefined);
  const statuses = statusIn(String(req.query.scope ?? ""));
  return `${pool}${keys ? ` AND ${keys}` : ""} AND b.status IN ${statuses}`;
}

/** Time-machine day (YYYY-MM-DD), or null for the live state. */
function parseAt(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

packsRouter.get("/packs", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const at = parseAt(req.query.at);
  const db = getDb();
  const synced = (
    db.prepare("SELECT COUNT(*) c FROM packs WHERE synced_at IS NOT NULL").get() as { c: number }
  ).c;
  if (synced === 0)
    return res.json({ synced: 0, pending: 0, categories: [] });

  const version = scoresVersion();
  const MAPS = mapScope(req, R);
  const key = `packs-${R}-${at ?? "now"}-${MAPS}`;
  const hit = cache.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < TTL_MS)
    return res.json(hit.payload);

  // per-pack aggregates over the maps of its sets, seen from this mode's
  // pool: total diffs, played, cleared, FC'd (only ranked/approved/loved).
  // Time machine (at): replayed from the stored scores instead of the live
  // flags. FC is the state of the BEST score made by that date — the same
  // definition as best_fc and as the pack detail below, so the counter and
  // the rows of the modal cannot disagree.
  const playedCol = at
    ? `SUM(CASE WHEN EXISTS(SELECT 1 FROM scores s WHERE s.beatmap_id = b.id
         AND s.ruleset = ${R} AND s.passed = 1 AND date(s.ended_at) <= @at)
         THEN 1 ELSE 0 END) AS played,
       SUM(CASE WHEN (SELECT s2.fc_state FROM scores s2
           WHERE s2.beatmap_id = b.id AND s2.ruleset = ${R} AND s2.passed = 1
             AND date(s2.ended_at) <= @at
           ORDER BY COALESCE(s2.classic_total_score, s2.total_score) DESC
           LIMIT 1) <= 1 THEN 1 ELSE 0 END) AS fced`
    : `SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) AS played,
       SUM(COALESCE(u.best_fc, 0)) AS fced`;
  const rows = db
    .prepare(
      `SELECT p.tag, p.name, p.type, p.date,
        COUNT(b.id) AS total,
        ${playedCol}
       FROM packs p
       JOIN pack_sets ps ON ps.tag = p.tag
       JOIN beatmaps b ON b.beatmapset_id = ps.beatmapset_id AND ${MAPS}
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       WHERE ${packWhere(R)} AND p.synced_at IS NOT NULL
       GROUP BY p.tag
       -- date ascending like the official pages; LENGTH before the text makes
       -- the tag tie-break numeric (S2 < S19 < S100, not S100 < S19 < S2)
       ORDER BY p.type, p.date, LENGTH(p.tag), p.tag`
    )
    .all(at ? { at } : {}) as {
    tag: string; name: string; type: string; date: string | null;
    total: number; played: number; fced: number;
  }[];

  const pending = (
    db.prepare("SELECT COUNT(*) c FROM packs WHERE synced_at IS NULL").get() as { c: number }
  ).c;
  const byType = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.total === 0) continue; // nothing of this pack exists in this mode
    const arr = byType.get(r.type) ?? [];
    arr.push(r);
    byType.set(r.type, arr);
  }
  const payload = {
    synced,
    pending,
    categories: [...byType.entries()].map(([type, packs]) => ({ type, packs })),
  };
  cache.set(key, { version, at: Date.now(), payload });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  res.json(payload);
});

packsRouter.get("/packs/:tag", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const at = parseAt(req.query.at);
  const db = getDb();
  const pack = db
    .prepare("SELECT tag, name, type, date, url FROM packs WHERE tag = ?")
    .get(String(req.params.tag)) as
    | { tag: string; name: string; type: string; date: string | null; url: string | null }
    | undefined;
  if (!pack) return res.status(404).json({ error: "unknown pack" });

  // Time machine: the displayed best is the best score MADE BY the date —
  // same definition as the live best pointer (refreshBest): highest CLASSIC
  // score, even if its grade is worse.
  const bestJoin = at
    ? `LEFT JOIN scores s ON s.id = (
         SELECT s2.id FROM scores s2
         WHERE s2.beatmap_id = b.id AND s2.ruleset = ${R} AND s2.passed = 1
           AND date(s2.ended_at) <= @at
         ORDER BY COALESCE(s2.classic_total_score, s2.total_score) DESC
         LIMIT 1)`
    : "LEFT JOIN scores s ON s.id = u.best_lazer_score_id";
  const playedCol = at
    ? "CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS played"
    : "COALESCE(u.played, 0) AS played";
  const maps = db
    .prepare(
      `SELECT b.id, st.artist, st.title, b.version, b.status, st.ranked_date,
        COALESCE(ca.star_rating, b.star_rating) AS star_rating,
        ${playedCol},
        s.rank AS grade, s.fc_state, s.accuracy
       FROM pack_sets ps
       JOIN beatmaps b ON b.beatmapset_id = ps.beatmapset_id AND ${mapScope(req, R)}
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       ${bestJoin}
       WHERE ps.tag = @tag
       ORDER BY st.artist, st.title, COALESCE(ca.star_rating, b.star_rating)`
    )
    .all(at ? { tag: pack.tag, at } : { tag: pack.tag });
  res.json({ ...pack, at, maps });
});

// Opt-in import of the pack definitions (~1 req/pack, resumable, progress in
// the sync bar). The monthly delta then keeps them fresh automatically.
packsRouter.post("/packs/import", (_req, res) => {
  if (!config.hasCredentials)
    return res.status(400).json({ ok: false, error: "osu! API credentials are not set" });
  void runPacksImport()
    .then((n) => console.log(`[packs] import done: ${n} pack(s)`))
    .catch((e) => console.error("[packs]", e));
  res.json({ ok: true, started: true, note: "Progress in the sync bar activity" });
});
