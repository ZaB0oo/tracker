/**
 * Pack completion endpoints: per-category aggregates for the dashboard grid,
 * per-pack map detail for the modal, and the opt-in definitions import.
 * A pack belongs to a tab when its ruleset matches (NULL = std sets: shown on
 * the osu! tab natively, and on the other tabs as converts).
 */
import { Router } from "express";
import { config } from "../config.js";
import { getDb } from "../db/db.js";
import { parseRulesetParam } from "../logic/rulesets.js";
import { scoresVersion } from "../logic/scoreSql.js";
import { runPacksImport } from "../sync/daemon.js";

export const packsRouter = Router();

const cache = new Map<string, { version: string; at: number; payload: unknown }>();
const TTL_MS = 60_000;

/** packs visible on this tab: native series + mode-agnostic (std-set) packs */
function packWhere(R: number): string {
  return R === 0 ? "(p.ruleset = 0 OR p.ruleset IS NULL)" : `(p.ruleset = ${R} OR p.ruleset IS NULL)`;
}

packsRouter.get("/packs", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const db = getDb();
  const synced = (
    db.prepare("SELECT COUNT(*) c FROM packs WHERE synced_at IS NOT NULL").get() as { c: number }
  ).c;
  if (synced === 0)
    return res.json({ synced: 0, pending: 0, categories: [] });

  const version = scoresVersion();
  const key = `packs-${R}`;
  const hit = cache.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < TTL_MS)
    return res.json(hit.payload);

  // per-pack aggregates over the maps of its sets, seen from this mode's
  // pool: total diffs, played, cleared, FC'd (only ranked/approved/loved)
  const rows = db
    .prepare(
      `SELECT p.tag, p.name, p.type, p.date,
        COUNT(b.id) AS total,
        SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) AS played,
        SUM(COALESCE(u.any_fc, 0)) AS fced
       FROM packs p
       JOIN pack_sets ps ON ps.tag = p.tag
       JOIN beatmaps b ON b.beatmapset_id = ps.beatmapset_id
         AND (b.ruleset = ${R} OR b.ruleset = 0) AND b.status IN (1, 2, 4)
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       WHERE ${packWhere(R)} AND p.synced_at IS NOT NULL
       GROUP BY p.tag
       -- date ascending like the official pages; LENGTH before the text makes
       -- the tag tie-break numeric (S2 < S19 < S100, not S100 < S19 < S2)
       ORDER BY p.type, p.date, LENGTH(p.tag), p.tag`
    )
    .all() as {
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
  res.json(payload);
});

packsRouter.get("/packs/:tag", (req, res) => {
  const R = parseRulesetParam(req.query.ruleset);
  const db = getDb();
  const pack = db
    .prepare("SELECT tag, name, type, date, url FROM packs WHERE tag = ?")
    .get(String(req.params.tag)) as
    | { tag: string; name: string; type: string; date: string | null; url: string | null }
    | undefined;
  if (!pack) return res.status(404).json({ error: "unknown pack" });

  const maps = db
    .prepare(
      `SELECT b.id, st.artist, st.title, b.version, b.status,
        COALESCE(ca.star_rating, b.star_rating) AS star_rating,
        COALESCE(u.played, 0) AS played,
        s.rank AS grade, s.fc_state, s.accuracy
       FROM pack_sets ps
       JOIN beatmaps b ON b.beatmapset_id = ps.beatmapset_id
         AND (b.ruleset = ${R} OR b.ruleset = 0) AND b.status IN (1, 2, 4)
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN convert_attrs ca ON ca.beatmap_id = b.id AND ca.ruleset = ${R} AND b.ruleset != ${R}
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${R}
       LEFT JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE ps.tag = ?
       ORDER BY st.artist, st.title, COALESCE(ca.star_rating, b.star_rating)`
    )
    .all(pack.tag);
  res.json({ ...pack, maps });
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
