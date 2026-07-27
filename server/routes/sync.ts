import { Router } from "express";
import { config } from "../config.js";
import { getDb, setState } from "../db/db.js";
import { isUserConnected } from "../osu/api.js";
import {
  clearSyncErrors,
  ensureCatalogComplete,
  getDaemonStatus,
  importSetById,
  pauseBackfill,
  pauseCountrySweep,
  pauseGlobalSweep,
  pollRecentScores,
  recomputeAllBests,
  refreshCatalogDelta,
  resumeBackfill,
  runBigSetsRepair,
  runCountrySweep,
  runGlobalSweep,
  runPipeline,
  verifyYearAndBackfill,
} from "../sync/daemon.js";

export const syncRouter = Router();

// Manual country leaderboard sweep (otherwise: auto after login, after each
// new score, and daily re-check of held #1s)
syncRouter.post("/sync/country-sweep", (_req, res) => {
  void runCountrySweep(true); // manual start: overrides the backfill deferral
  res.json({ ok: true, started: true });
});
syncRouter.post("/sync/country-pause", (_req, res) => {
  pauseCountrySweep();
  res.json({ ok: true });
});

// Global tops sweep (top 1/8/15/25/50/100 positions). Starting also enables
// the periodic re-checks; pausing disables them (single toggle in the UI).
syncRouter.post("/sync/global-sweep", (_req, res) => {
  setState("global_tracking", "1");
  void runGlobalSweep(true);
  res.json({ ok: true, started: true });
});
syncRouter.post("/sync/global-pause", (_req, res) => {
  setState("global_tracking", "0");
  pauseGlobalSweep();
  res.json({ ok: true });
});

// Manual full re-check of ALL global positions (any depth, not just the
// top-100 rotation): every played map goes back into the sweep queue
// (~25 h for ~90k maps, resumable). Also (re)enables the tracking.
syncRouter.post("/sync/global-recheck-all", (_req, res) => {
  const n = getDb()
    .prepare(
      "UPDATE beatmap_user SET global_checked_at = NULL WHERE ruleset = 0 AND played = 1"
    )
    .run().changes;
  setState("global_tracking", "1");
  void runGlobalSweep(true);
  res.json({ ok: true, requeued: Number(n) });
});

// Targeted pp refresh: re-fetches the scores of the top ~250 maps by LOCAL
// best pp, plus your OFFICIAL top 100 (users/{id}/scores/best) — after a pp
// rework the ordering changes, and a map absent from the local top can surge
// into the official one. Union of both ≈ 4 min instead of a 40 h re-backfill.
syncRouter.post("/sync/refresh-top-pp", async (_req, res) => {
  const db = getDb();
  const ids = new Set<number>(
    (
      db
        .prepare(
          `SELECT s.beatmap_id AS bid FROM scores s
           WHERE s.pp IS NOT NULL AND s.passed = 1
           GROUP BY s.beatmap_id
           ORDER BY MAX(s.pp) DESC LIMIT 250`
        )
        .all() as { bid: number }[]
    ).map((r) => r.bid)
  );
  // official post-rework ranking; offline / API failure / slow token
  // acquisition → fall back to the local list only (bounded wait)
  let fromOfficial = 0;
  try {
    const { getBestScores } = await import("../osu/api.js");
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("official top: timeout")), 20_000)
    );
    const official = await Promise.race([
      (async () => [
        ...(await getBestScores(config.osuUserId, 50, 0)),
        ...(await getBestScores(config.osuUserId, 50, 50)),
      ])(),
      timeout,
    ]);
    for (const s of official)
      if (!ids.has(s.beatmap_id)) {
        ids.add(s.beatmap_id);
        fromOfficial++;
      }
  } catch {
    // keep going with the local top only
  }
  const upd = db.prepare(
    "UPDATE beatmap_user SET fetched_at = NULL WHERE beatmap_id = ? AND ruleset = 0"
  );
  let n = 0;
  for (const id of ids) n += Number(upd.run(id).changes);
  void resumeBackfill();
  res.json({ ok: true, requeued: n, fromOfficialTop: fromOfficial });
});

// Full score re-scan: puts every map back to "to check" (no existing score
// is lost, ~40h). Use it if the app stayed off for > 24h while you played.
syncRouter.post("/sync/rebackfill", (_req, res) => {
  const db = getDb();
  // std only for now: the multi-ruleset backfills get their own controls (M3)
  db.exec("UPDATE beatmap_user SET fetched_at = NULL WHERE ruleset = 0");
  // integrated country re-sweep: all played maps go back to the #1 check
  // (also catches "inherited" #1s without replaying)
  db.exec(
    "UPDATE beatmap_user SET country_checked_at = NULL WHERE ruleset = 0 AND played = 1"
  );
  void resumeBackfill();
  if (isUserConnected()) void runCountrySweep();
  res.json({
    ok: true,
    note: "Re-backfill + country re-sweep started, tracked in the sync bar",
  });
});

syncRouter.post("/sync/clear-errors", (_req, res) => {
  clearSyncErrors();
  res.json({ ok: true });
});

syncRouter.get("/sync/status", (_req, res) => res.json(getDaemonStatus()));

syncRouter.post("/sync/start", (req, res) => {
  if (!config.hasCredentials)
    return res.status(400).json({
      ok: false,
      error:
        "osu! API credentials are not set — open Settings (menu) and fill in the Client ID / secret / user id first.",
    });
  void runPipeline({ skipCatalog: req.query.skipCatalog === "1" });
  res.json({ ok: true });
});

syncRouter.post("/sync/pause", (_req, res) => {
  pauseBackfill();
  res.json({ ok: true });
});

syncRouter.post("/sync/resume", (_req, res) => {
  void resumeBackfill();
  res.json({ ok: true });
});

syncRouter.post("/sync/poll-now", async (_req, res) => {
  try {
    const n = await pollRecentScores();
    res.json({ ok: true, newScores: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

syncRouter.post("/sync/recompute", (_req, res) => {
  res.json({ ok: true, recomputed: recomputeAllBests() });
});

// Manual catch-up of new ranked/loved maps (otherwise: auto ~1x/day)
syncRouter.post("/sync/delta-now", async (_req, res) => {
  try {
    const n = await refreshCatalogDelta();
    res.json({ ok: true, newMaps: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Complete the catalog via full API enumeration.
// ?force=1: full re-scan even if the catalog looks complete (updates statuses
// and DMCA flags of all sets).
// Targeted year verification: re-enumerates the search for the year (~100 req,
// a few minutes) and compares with the local DB.
// Delisted sets found are imported (API then web page) + backfilled.
// Synchronous response with details. Ex: curl -X POST .../api/sync/verify-year/2024
syncRouter.post("/sync/verify-year/:year", async (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 2007 || year > 2100)
    return res.status(400).json({ ok: false, error: "invalid year" });
  try {
    const result = await verifyYearAndBackfill(year);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Manual import of a beatmapset by id (tries the API then the web page),
// scores backfilled right after. Ex: curl -X POST .../api/sync/import-set/2135112
syncRouter.post("/sync/import-set/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ ok: false, error: "invalid set id" });
  try {
    const result = await importSetById(id);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Diagnostic: local pp state vs the official "Best performance" list.
// Compares your official top 100 with the DB's best-pp per map and reports
// stale values, missing scores, and local maps that outrank the official list
// (e.g. a map that went loved: osu! stops counting it, the DB still would).
// Open http://localhost:3727/api/debug/pp-diff in a browser.
syncRouter.get("/debug/pp-diff", async (_req, res) => {
  try {
    const { getBestScores } = await import("../osu/api.js");
    const official = [
      ...(await getBestScores(config.osuUserId, 50, 0)),
      ...(await getBestScores(config.osuUserId, 50, 50)),
    ];
    const db = getDb();
    const ourBest = db
      .prepare(
        `SELECT s.beatmap_id AS bid, MAX(s.pp) AS pp, b.status AS status
         FROM scores s JOIN beatmaps b ON b.id = s.beatmap_id
         WHERE s.pp IS NOT NULL AND s.passed = 1
         GROUP BY s.beatmap_id ORDER BY pp DESC LIMIT 150`
      )
      .all() as { bid: number; pp: number; status: number }[];
    const oursByMap = new Map(ourBest.map((r) => [r.bid, r]));
    const officialByMap = new Map(
      official.map((s) => [s.beatmap_id, s.pp ?? 0])
    );
    const stale: unknown[] = [];
    const missing: unknown[] = [];
    for (const s of official) {
      const ours = oursByMap.get(s.beatmap_id);
      const opp = s.pp ?? 0;
      if (!ours)
        missing.push({ beatmap_id: s.beatmap_id, official_pp: opp });
      else if (Math.abs(ours.pp - opp) > 0.01)
        stale.push({
          beatmap_id: s.beatmap_id,
          official_pp: opp,
          local_pp: ours.pp,
          diff: Number((ours.pp - opp).toFixed(2)),
        });
    }
    const floor = Math.min(...official.map((s) => s.pp ?? 0));
    const extra = ourBest
      .filter((r) => !officialByMap.has(r.bid) && r.pp > floor)
      .map((r) => ({
        beatmap_id: r.bid,
        local_pp: r.pp,
        status: r.status,
        note:
          r.status === 4
            ? "LOVED — osu! does not count it, the metric should not either"
            : "above the official top-100 floor but absent from it",
      }));
    res.json({
      officialTop: official.length,
      officialFloorPp: floor,
      stale,
      missingLocally: missing,
      extraLocally: extra,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Diagnostic: which channel sees a set (API / web page / local DB)?
syncRouter.get("/debug/set/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { getBeatmapsetById } = await import("../osu/api.js");
  const { fetchBeatmapsetFromWeb, stdDiffCount } = await import("../sync/catalog.js");
  const db = getDb();
  const local = db
    .prepare(
      "SELECT COUNT(*) c FROM beatmaps WHERE beatmapset_id = ? AND ruleset = 0"
    )
    .get(id) as { c: number };
  const out: Record<string, unknown> = { db_std_diffs: local.c };
  try {
    const api = await getBeatmapsetById(id);
    out.api = api
      ? { found: true, total_diffs: api.beatmaps?.length ?? 0, std_diffs: stdDiffCount(api) }
      : { found: false };
  } catch (e) {
    out.api = { error: String(e) };
  }
  try {
    const web = await fetchBeatmapsetFromWeb(id);
    out.web = web
      ? { found: true, total_diffs: web.beatmaps?.length ?? 0, std_diffs: stdDiffCount(web) }
      : { found: false };
  } catch (e) {
    out.web = { error: String(e) };
  }
  res.json(out);
});

// Repairs mega-collabs (> 100 diffs, truncated API payload) via the web page
syncRouter.post("/sync/repair-big-sets", async (_req, res) => {
  try {
    const n = await runBigSetsRepair();
    res.json({ ok: true, newDiffs: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

syncRouter.post("/sync/catalog-full", (req, res) => {
  // async: can take > 1h (rate limit shared with the backfill).
  // Tracked via GET /api/sync/status (message + counters).
  void ensureCatalogComplete(req.query.force === "1").catch((e) =>
    console.error("[sync] catalog-full:", e)
  );
  res.json({ ok: true, started: true, note: "Tracked via /api/sync/status" });
});
