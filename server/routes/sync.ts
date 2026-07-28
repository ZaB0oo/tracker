import { Router } from "express";
import { config } from "../config.js";
import { packSeedCounts } from "../logic/rulesets.js";
import { getActiveRulesets, getDb, getStartedRulesets, setState } from "../db/db.js";
import { isUserConnected } from "../osu/api.js";
import {
  clearSyncErrors,
  ensureCatalogComplete,
  enrichCatalog,
  getDaemonStatus,
  importSetById,
  pauseBackfill,
  pauseCountrySweep,
  pauseGlobalSweep,
  pollRecentScores,
  recomputeAllBests,
  refreshCatalogDelta,
  resumeBackfill,
  runCatalogRepair,
  runDumpVerify,
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
syncRouter.post("/sync/global-recheck-all", (req, res) => {
  // ?ruleset=N: only that mode (the UI scopes it to the viewed tab)
  const r = req.query.ruleset != null ? Number(req.query.ruleset) : null;
  const scope =
    r != null && [0, 1, 2, 3].includes(r) ? [r] : getActiveRulesets();
  const n = getDb()
    .prepare(
      `UPDATE beatmap_user SET global_checked_at = NULL
       WHERE ruleset IN (${scope.join(",")}) AND played = 1`
    )
    .run().changes;
  setState("global_tracking", "1");
  void runGlobalSweep(true);
  res.json({ ok: true, requeued: Number(n) });
});

// Targeted pp refresh: re-fetches the scores of the top ~250 maps by LOCAL
// best pp, plus your OFFICIAL top 100 (users/{id}/scores/best) — after a pp
// rework the ordering changes, and a map absent from the local top can surge
// into the official one.
syncRouter.post("/sync/refresh-top-pp", async (req, res) => {
  const db = getDb();
  const upd = db.prepare(
    "UPDATE beatmap_user SET fetched_at = NULL WHERE beatmap_id = ? AND ruleset = ?"
  );
  let n = 0;
  let fromOfficial = 0;
  const rq = req.query.ruleset != null ? Number(req.query.ruleset) : null;
  const scope =
    rq != null && [0, 1, 2, 3].includes(rq) ? [rq] : getStartedRulesets();
  // one pass per mode in scope: local top-250 by pp, plus the OFFICIAL top
  // 100 of that mode (after a pp rework a map absent from the local top can
  // surge into the official one)
  for (const R of scope) {
    const ids = new Set<number>(
      (
        db
          .prepare(
            `SELECT s.beatmap_id AS bid FROM scores s
             WHERE s.pp IS NOT NULL AND s.passed = 1 AND s.ruleset = ${R}
             GROUP BY s.beatmap_id
             ORDER BY MAX(s.pp) DESC LIMIT 250`
          )
          .all() as { bid: number }[]
      ).map((r) => r.bid)
    );
    // offline / API failure / slow token acquisition → local list only
    try {
      const { getBestScores } = await import("../osu/api.js");
      const { rulesetDef } = await import("../logic/rulesets.js");
      const modeName = rulesetDef(R).apiName;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("official top: timeout")), 20_000)
      );
      const official = await Promise.race([
        (async () => [
          ...(await getBestScores(config.osuUserId, 50, 0, modeName)),
          ...(await getBestScores(config.osuUserId, 50, 50, modeName)),
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
    for (const id of ids) n += Number(upd.run(id, R).changes);
  }
  void resumeBackfill();
  res.json({ ok: true, requeued: n, fromOfficialTop: fromOfficial });
});

// Full score re-scan: puts every map back to "to check" (no existing score
// is lost). Use it if the app stayed off for > 24h while you played.
syncRouter.post("/sync/rebackfill", (req, res) => {
  const db = getDb();
  const rq = req.query.ruleset != null ? Number(req.query.ruleset) : null;
  const started = (
    rq != null && [0, 1, 2, 3].includes(rq) ? [rq] : getStartedRulesets()
  ).join(",");
  db.exec(`UPDATE beatmap_user SET fetched_at = NULL WHERE ruleset IN (${started})`);
  // integrated country re-sweep: all played maps go back to the #1 check
  // (also catches "inherited" #1s without replaying)
  db.exec(
    `UPDATE beatmap_user SET country_checked_at = NULL WHERE ruleset IN (${started}) AND played = 1`
  );
  void resumeBackfill();
  if (isUserConnected()) void runCountrySweep();
  res.json({
    ok: true,
    note: "Score re-import + country re-sweep started, tracked in the sync bar",
  });
});

// Per-mode initial sync (taiko/catch/mania): the ruleset must be active in
// Settings; nothing runs for a mode before this explicit start. Chains like
// the std pipeline: catalog enumeration → enrichment → backfill (the shared
// backfill picks up the new specific + converts queues) → sweeps follow.
syncRouter.post("/sync/start-ruleset/:r", (req, res) => {
  const r = Number(req.params.r);
  if (![1, 2, 3].includes(r))
    return res.status(400).json({ ok: false, error: "ruleset must be 1, 2 or 3" });
  if (!getActiveRulesets().includes(r))
    return res
      .status(400)
      .json({ ok: false, error: "activate this ruleset in Settings first" });
  if (!config.hasCredentials)
    return res.status(400).json({ ok: false, error: "osu! API credentials are not set" });
  setState(`ruleset_started_${r}`, "1");
  void (async () => {
    try {
      // THIS mode only: the std base re-scan must not delay the new mode's
      // backfill (it keeps running on its own schedule: daily delta,
      // catalog-full maintenance)
      await ensureCatalogComplete(false, [r]);
      // completeness first: the known-sets list adds what the search cannot
      // see, so the map count is final within minutes
      await runCatalogRepair();
      // then the slow per-map pass, then the scores
      await enrichCatalog();
      await resumeBackfill();
    } catch (e) {
      console.error(`[sync] start ruleset ${r}:`, e);
    }
  })();
  res.json({ ok: true, started: true });
});

// Downloadable seed list: every set with at least one ranked/approved/loved
// diff, ANY mode — the format of server/db/seed-sets.json, so a complete
// catalog (e.g. after a dump verification) can be shipped as the new seed,
// DMCA/delisted sets included.
// `{ v: 2, sets: { "<set id>": <packed counts> } }`: how many ranked/approved/
// loved diffs the set has per ruleset, 8 bits each (osu!, taiko, catch, mania).
// Counts, not just flags: that is what lets the catch-up spot a set holding
// SOME of a mode's diffs but not all of them.
syncRouter.get("/sync/export-known-sets", (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT beatmapset_id AS id, ruleset, COUNT(*) n FROM beatmaps
       WHERE status IN (1, 2, 4)
       GROUP BY beatmapset_id, ruleset ORDER BY beatmapset_id`
    )
    .all() as { id: number; ruleset: number; n: number }[];
  const perSet = new Map<number, number[]>();
  for (const r of rows) {
    const c = perSet.get(r.id) ?? [0, 0, 0, 0];
    c[r.ruleset] = r.n;
    perSet.set(r.id, c);
  }
  const sets: Record<string, number> = {};
  for (const [id, counts] of perSet) sets[id] = packSeedCounts(counts);
  res.setHeader("Content-Disposition", "attachment; filename=seed-sets.json");
  res.json({ v: 2, sets });
});

syncRouter.post("/sync/clear-errors", (_req, res) => {
  clearSyncErrors();
  res.json({ ok: true });
});

syncRouter.get("/sync/status", (_req, res) => res.json(getDaemonStatus()));

// osu!std initial sync — the std counterpart of /sync/start-ruleset/:r: nothing
// runs for std before this either, so a fresh install stays idle until asked.
syncRouter.post("/sync/start", (req, res) => {
  if (!config.hasCredentials)
    return res.status(400).json({
      ok: false,
      error:
        "osu! API credentials are not set — open Settings (menu) and fill in the Client ID / secret / user id first.",
    });
  if (!getActiveRulesets().includes(0))
    return res
      .status(400)
      .json({ ok: false, error: "enable osu! in Settings first" });
  setState("ruleset_started_0", "1");
  void runPipeline({ skipCatalog: req.query.skipCatalog === "1" });
  res.json({ ok: true });
});

syncRouter.post("/sync/pause", (_req, res) => {
  pauseBackfill();
  res.json({ ok: true });
});

// Per-mode backfill pause: the shared backfill simply skips that mode's
// passes (persistent flag, survives restarts). Resume clears it and kicks
// the backfill again.
syncRouter.post("/sync/backfill-pause/:r", (req, res) => {
  const r = Number(req.params.r);
  if (![0, 1, 2, 3].includes(r))
    return res.status(400).json({ ok: false, error: "ruleset must be 0-3" });
  setState(`backfill_paused_m${r}`, "1");
  res.json({ ok: true });
});
syncRouter.post("/sync/backfill-resume/:r", (req, res) => {
  const r = Number(req.params.r);
  if (![0, 1, 2, 3].includes(r))
    return res.status(400).json({ ok: false, error: "ruleset must be 0-3" });
  setState(`backfill_paused_m${r}`, "0");
  void resumeBackfill();
  res.json({ ok: true });
});

syncRouter.post("/sync/resume", (_req, res) => {
  for (const r of [0, 1, 2, 3]) setState(`backfill_paused_m${r}`, "0");
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
    // status verification: how many of the set's diffs actually count
    // (ranked/approved/loved) — a graveyard set is stored but never enters
    // any pool, the UI can tell the user right away
    const rows = getDb()
      .prepare(
        `SELECT CASE WHEN status IN (1, 2) THEN 'ranked'
                     WHEN status = 4 THEN 'loved'
                     ELSE 'other' END AS s, COUNT(*) c
         FROM beatmaps WHERE beatmapset_id = ? GROUP BY s`
      )
      .all(id) as { s: string; c: number }[];
    const statuses = Object.fromEntries(rows.map((r) => [r.s, r.c]));
    res.json({ ok: true, ...result, statuses });
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
  const { fetchBeatmapsetFromWeb, keptDiffCount } = await import("../sync/catalog.js");
  const db = getDb();
  const local = db
    .prepare(
      `SELECT COUNT(*) c, GROUP_CONCAT(DISTINCT ruleset) modes
       FROM beatmaps WHERE beatmapset_id = ?`
    )
    .get(id) as { c: number; modes: string | null };
  const out: Record<string, unknown> = {
    db_diffs: local.c,
    db_modes: local.modes ?? "",
  };
  try {
    const api = await getBeatmapsetById(id);
    out.api = api
      ? { found: true, total_diffs: api.beatmaps?.length ?? 0, kept_diffs: keptDiffCount(api) }
      : { found: false };
  } catch (e) {
    out.api = { error: String(e) };
  }
  try {
    const web = await fetchBeatmapsetFromWeb(id);
    out.web = web
      ? { found: true, total_diffs: web.beatmaps?.length ?? 0, kept_diffs: keptDiffCount(web) }
      : { found: false };
  } catch (e) {
    out.web = { error: String(e) };
  }
  res.json(out);
});

// One-click catalog repair (known DMCA sets + truncated mega-collabs).
syncRouter.post("/sync/repair-catalog", (_req, res) => {
  if (!config.hasCredentials)
    return res.status(400).json({ ok: false, error: "osu! API credentials are not set" });
  void runCatalogRepair()
    .then((added) => console.log(`[repair] done: ${added}`))
    .catch((e) => console.error("[repair]", e));
  res.json({ ok: true, started: true, note: "Progress in the sync bar activity" });
});

// Catalog verification against a local data.ppy.sh dump file (see
// server/sync/dump.ts). Local file path => loopback only, like the DB import.
syncRouter.post("/sync/verify-dump", (req, res) => {
  const ip = req.ip ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip))
    return res.status(403).json({ ok: false, error: "local access only" });
  if (!config.hasCredentials)
    return res.status(400).json({ ok: false, error: "osu! API credentials are not set" });
  const path = String((req.body as { path?: string } | undefined)?.path ?? "").trim();
  if (!path) return res.status(400).json({ ok: false, error: "path required" });
  const dr = (req.body as { ruleset?: number } | undefined)?.ruleset;
  void runDumpVerify(path, dr != null && [0, 1, 2, 3].includes(dr) ? [dr] : undefined)
    .then((added) => console.log(`[dump] done: ${added}`))
    .catch((e) => console.error("[dump]", e));
  res.json({ ok: true, started: true, note: "Progress in the sync bar activity" });
});

syncRouter.post("/sync/catalog-full", (req, res) => {
  // async: can take > 1h (rate limit shared with the backfill).
  // Tracked via GET /api/sync/status (message + counters).
  // ?ruleset=N: re-scan only that mode's slices
  const r = req.query.ruleset != null ? Number(req.query.ruleset) : null;
  void ensureCatalogComplete(
    req.query.force === "1",
    r != null && [0, 1, 2, 3].includes(r) ? [r] : undefined
  ).catch((e) => console.error("[sync] catalog-full:", e));
  res.json({ ok: true, started: true, note: "Tracked via /api/sync/status" });
});
