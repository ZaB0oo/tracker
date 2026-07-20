import { Router } from "express";
import { getDb } from "../db/db.js";
import { isUserConnected } from "../osu/api.js";
import {
  clearSyncErrors,
  ensureCatalogComplete,
  getDaemonStatus,
  importSetById,
  pauseBackfill,
  pauseCountrySweep,
  pollRecentScores,
  recomputeAllBests,
  refreshCatalogDelta,
  resumeBackfill,
  runBigSetsRepair,
  runCountrySweep,
  runPipeline,
  verifyYearAndBackfill,
} from "../sync/daemon.js";

export const syncRouter = Router();

// Manual country leaderboard sweep (otherwise: auto after login, after each
// new score, and daily re-check of held #1s)
syncRouter.post("/sync/country-sweep", (_req, res) => {
  void runCountrySweep();
  res.json({ ok: true, started: true });
});
syncRouter.post("/sync/country-pause", (_req, res) => {
  pauseCountrySweep();
  res.json({ ok: true });
});

// Full score re-scan: puts every map back to "to check" (no existing score
// is lost, ~40h). Use it if the app stayed off for > 24h while you played.
syncRouter.post("/sync/rebackfill", (_req, res) => {
  const db = getDb();
  db.exec("UPDATE beatmap_user SET fetched_at = NULL");
  // integrated country re-sweep: all played maps go back to the #1 check
  // (also catches "inherited" #1s without replaying)
  db.exec("UPDATE beatmap_user SET country_checked_at = NULL WHERE played = 1");
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
