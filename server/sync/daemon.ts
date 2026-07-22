/**
 * Sync daemon: orchestrates catalog -> enrichment -> backfill, plus the
 * periodic polling of new scores (highest priority of all), plus the daily
 * catch-up of newly ranked/loved maps.
 *
 * Steps persisted in sync_state, everything is resumable after crash/stop:
 *  - backfill: only maps with fetched_at NULL are processed => trivial resume
 *  - catalog API: cursor_string persisted
 *  - daily delta: timestamp persisted (catalog_delta_at)
 */
import { config } from "../config.js";
import { getDb, getState, setState } from "../db/db.js";
import {
  getBeatmapsByIds,
  getCountryTop,
  getRecentScores,
  getStoredCountryCode,
  getUserBeatmapScores,
  isUserConnected,
  limiter,
} from "../osu/api.js";
import { markFetchedEmpty, saveScores, refreshBest } from "../logic/repo.js";
import {
  enrichMaxCombo,
  importCatalogFromApi,
  importOneSet,
  repairOversizedSets,
  updateCatalogDelta,
  verifyYear,
} from "./catalog.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type Phase =
  | "idle"
  | "catalog"
  | "enrich"
  | "backfill"
  | "done"
  | "error";

interface ActivityEntry {
  at: string;
  source: string;
  text: string;
}

interface DaemonStatus {
  phase: Phase;
  message: string;
  messageAt: string | null; // timestamp of the last message (UI freshness)
  backfill: { fetched: number; total: number; running: boolean };
  enrich: { done: number; total: number };
  lastPollAt: string | null;
  lastPollNewScores: number;
  lastDeltaAt: string | null;
  lastDeltaNewMaps: number;
  queue: { high: number; low: number };
  errors: string[];
  activity: ActivityEntry[];
}

const statusData: DaemonStatus = {
  phase: "idle",
  message: "",
  messageAt: null,
  backfill: { fetched: 0, total: 0, running: false },
  enrich: { done: 0, total: 0 },
  lastPollAt: null,
  lastPollNewScores: 0,
  lastDeltaAt: null,
  lastDeltaNewMaps: 0,
  queue: { high: 0, low: 0 },
  errors: [],
  activity: [],
};

// Activity feed for the UI (scrollable area of the syncbar + dedicated
// window): latest actions of the background tasks. No throttle: at the API
// rate limit pace (~1 map/s max), the rate stays readable. Circular buffer.
const ACTIVITY_MAX = 300;
function logActivity(source: string, text: string | (() => string)): void {
  statusData.activity = [
    ...statusData.activity.slice(-(ACTIVITY_MAX - 1)),
    {
      at: new Date().toISOString(),
      source,
      text: typeof text === "function" ? text() : text,
    },
  ];
}

/** "Artist - Title [Diff]" for the activity feed. */
function mapLabel(beatmapId: number): string {
  const r = getDb()
    .prepare(
      `SELECT st.artist || ' - ' || st.title || ' [' || b.version || ']' AS label
       FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
       WHERE b.id = ?`
    )
    .get(beatmapId) as { label: string } | undefined;
  return r?.label ?? `map ${beatmapId}`;
}

// Every write to `status.message` is timestamped automatically: the UI can
// hide stale messages.
const status = new Proxy(statusData, {
  set(target, prop, value) {
    if (prop === "message") target.messageAt = new Date().toISOString();
    (target as unknown as Record<string | symbol, unknown>)[prop] = value;
    return true;
  },
}) as DaemonStatus;

let backfillWanted = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let deltaTimer: ReturnType<typeof setInterval> | null = null;
let enrichCatchupRunning = false;
let deltaRunning = false;

export function getDaemonStatus(): DaemonStatus & { busy: string[] } {
  const db = getDb();
  const total = (
    db.prepare("SELECT COUNT(*) c FROM beatmaps WHERE ruleset = 0").get() as {
      c: number;
    }
  ).c;
  const fetched = (
    db
      .prepare(
        `SELECT COUNT(*) c FROM beatmaps b
         JOIN beatmap_user u ON u.beatmap_id = b.id
         WHERE b.ruleset = 0 AND u.fetched_at IS NOT NULL`
      )
      .get() as { c: number }
  ).c;
  status.backfill.total = total;
  status.backfill.fetched = fetched;
  status.queue = limiter.queueSizes;
  status.lastDeltaAt = getState("catalog_delta_at");

  // What is running RIGHT NOW (the old "phase" only covered the pipeline)
  const busy: string[] = [];
  if (status.phase === "catalog") busy.push("catalog import");
  if (status.phase === "enrich") busy.push("enrichment");
  if (status.backfill.running) busy.push("backfill");
  if (countryRunning) {
    const cc = getStoredCountryCode();
    busy.push(`${cc ? `#1 ${cc}` : "country #1"} sweep`);
  }
  if (deltaRunning) busy.push("new maps");
  return { ...status, busy };
}

export function clearSyncErrors(): void {
  status.errors = [];
}

function logError(e: unknown, ctx?: string) {
  const raw = e instanceof Error ? e.message : String(e);
  const msg = ctx ? `[${ctx}] ${raw}` : raw;
  status.errors = [...status.errors.slice(-9), `${new Date().toISOString()} ${msg}`];
  console.error("[sync]", msg);
}

/** Progress callback shared by the enrichment passes. */
const enrichProgress = (done: number, total: number) => {
  status.enrich = { done, total };
  logActivity("enrich", `${done}/${total} maps enriched (max combo / SR)`);
};

// ---------- Polling (high priority) ----------

export async function pollRecentScores(): Promise<number> {
  let offset = 0;
  let newCount = 0;
  const byBeatmap = new Map<number, import("../osu/types.js").SoloScore[]>();
  for (;;) {
    const batch = await getRecentScores(config.osuUserId, 50, offset);
    for (const s of batch) {
      const bid = s.beatmap_id ?? s.beatmap?.id;
      if (!bid) continue;
      const list = byBeatmap.get(bid) ?? [];
      list.push({ ...s, beatmap_id: bid });
      byBeatmap.set(bid, list);
    }
    if (batch.length < 50) break;
    offset += 50;
  }

  const db = getDb();

  // Maps absent from the catalog (just ranked, or catalog not imported yet):
  // we import the FULL MAPSET (all diffs, not just the played diff), with
  // backfill of any scores on the other diffs.
  const knownMap = db.prepare("SELECT 1 FROM beatmaps WHERE id = ?");
  const unknown = [...byBeatmap.keys()].filter((id) => !knownMap.get(id));
  if (unknown.length > 0) {
    const setIds = new Set<number>();
    const needLookup: number[] = [];
    for (const id of unknown) {
      const sid = byBeatmap.get(id)?.[0]?.beatmap?.beatmapset_id;
      if (sid) setIds.add(sid);
      else needLookup.push(id);
    }
    for (let i = 0; i < needLookup.length; i += 50) {
      try {
        const fetched = await getBeatmapsByIds(needLookup.slice(i, i + 50), "high");
        for (const b of fetched) setIds.add(b.beatmapset_id);
      } catch (e) {
        logError(e, "poll: lookup of new maps");
      }
    }
    for (const sid of setIds) {
      try {
        await importSetById(sid);
      } catch (e) {
        logError(e, `poll: import of set ${sid}`);
      }
    }
  }

  const exists = db.prepare("SELECT 1 FROM scores WHERE id = ?");
  const freshBeatmapIds: number[] = [];
  for (const [beatmapId, scores] of byBeatmap) {
    const fresh = scores.filter((s) => !exists.get(s.id));
    if (fresh.length === 0) continue;
    newCount += fresh.length;
    // markFetched: false => the map stays in the backfill queue, which will
    // later fetch the FULL list (old bests included)
    saveScores(beatmapId, fresh, { markFetched: false });
    freshBeatmapIds.push(beatmapId);
    logActivity(
      "poll",
      () => `${mapLabel(beatmapId)} — ${fresh.length} new score(s)`
    );
  }

  // New score => IMMEDIATE country leaderboard check at high priority (without
  // it, the map would wait its turn behind the whole initial sweep).
  if (freshBeatmapIds.length > 0 && isUserConnected()) {
    const invalidateCountry = db.prepare(
      "UPDATE beatmap_user SET country_checked_at = NULL WHERE beatmap_id = ?"
    );
    for (const id of freshBeatmapIds) {
      try {
        const top = await getCountryTop(id, "high");
        applyCountryCheck(id, top, true);
        // The leaderboard can lag behind a fresh submit: if I'm not on top
        // right now, don't trust the result. Leave the map in the sweep queue
        // (survives a restart: the periodic tick re-checks it within minutes)
        // AND schedule a quick confirmation ~10 min from now.
        if (!(top && top.user_id === config.osuUserId)) {
          invalidateCountry.run(id);
          scheduleCountryConfirm(id);
        }
      } catch (e) {
        logError(e, `immediate country check map ${id}`);
        invalidateCountry.run(id); // the background sweep will retry
        const msg = String(e);
        if (msg.includes("not connected") || msg.includes("supporter")) break;
      }
    }
  }
  status.lastPollAt = new Date().toISOString();
  status.lastPollNewScores = newCount;
  setState("last_poll_at", status.lastPollAt);
  return newCount;
}

function getPollMs(): number {
  const v = Number(getState("poll_interval_seconds"));
  return (Number.isFinite(v) && v >= 10 ? v : config.pollIntervalSeconds) * 1000;
}

/** Delay (hours) before re-checking a held country #1 — configurable in the UI. */
export function getCountryRecheckHours(): number {
  const v = Number(getState("country_recheck_hours"));
  // 48h default: with 20k+ #1s a 24h cycle would spend hours/day just
  // re-checking, competing with polling and new-map catch-up.
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : 48;
}

export function startPolling(): void {
  if (pollTimer) return;
  const tick = () =>
    void pollRecentScores().catch((e) =>
      logError(e, "poll of recent scores (will retry on the next tick)")
    );
  tick();
  pollTimer = setInterval(tick, getPollMs());
}

/** Re-applies the polling interval after a settings change. */
export function applyPollInterval(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  startPolling();
}

// ---------- Catalog completeness ----------

/**
 * The data.ppy.sh "performance" dumps only contain a subset of the beatmaps
 * (those played by the top players). If the catalog is abnormally small
 * (< MIN_EXPECTED_STD_DIFFS std diffs while ~150k ranked/loved exist in 2026),
 * we complete it with a full enumeration of /beatmapsets/search sliced by year
 * (the search caps at ~10k results per request). Idempotent: upserts, the
 * backfill picks up the new maps.
 */
const MIN_EXPECTED_STD_DIFFS = 140_000;

export async function ensureCatalogComplete(force = false): Promise<number> {
  const db = getDb();
  const count = () =>
    (db.prepare("SELECT COUNT(*) c FROM beatmaps WHERE ruleset = 0").get() as {
      c: number;
    }).c;
  const before = count();
  if (before === 0) return 0;
  if (!force && before >= MIN_EXPECTED_STD_DIFFS) return 0;

  status.message = `Incomplete catalog (${before} diffs, ~150k expected) — completing via the API...`;
  console.log(`[sync] ${status.message}`);
  // without force: resumes unfinished yearly slices (resumable);
  // with force: re-scans everything (also updates statuses + DMCA flags)
  await importCatalogFromApi((m) => {
    status.message = m;
    logActivity("catalog", m);
  }, { reset: force });
  await enrichMaxCombo(enrichProgress);
  const added = count() - before;
  console.log(`[sync] catalog completed: +${added} diffs`);
  return added;
}

// ---------- Daily delta: new ranked/loved maps ----------

/**
 * Catches up on new beatmapsets, enriches their max_combo, then backfills only
 * these new diffs (without touching the global backfill state).
 */
export async function refreshCatalogDelta(): Promise<number> {
  if (deltaRunning) return 0;
  deltaRunning = true;
  try {
    const db = getDb();
    const hasCatalog =
      (db.prepare("SELECT COUNT(*) c FROM beatmaps").get() as { c: number }).c > 0;
    if (!hasCatalog) return 0; // the initial sync will handle it

    const newIds = await updateCatalogDelta((m) => {
      status.message = m;
      logActivity("new maps", m);
    });
    status.lastDeltaNewMaps = newIds.length;
    if (newIds.length === 0) return 0;

    // up-to-date max_combo / SR for the new diffs (they have max_combo NULL)
    await enrichMaxCombo(enrichProgress);

    // targeted backfill: only the new diffs
    for (const id of newIds) {
      try {
        const scores = await getUserBeatmapScores(id, config.osuUserId, "low");
        if (scores.length === 0) markFetchedEmpty(id);
        else saveScores(id, scores);
      } catch (e) {
        logError(e, `delta: backfill map ${id}`);
      }
    }
    logActivity("new maps", `+${newIds.length} new diff(s) added`);
    console.log(`[sync] delta: ${newIds.length} new diffs added`);
    return newIds.length;
  } finally {
    deltaRunning = false;
  }
}

export function startCatalogRefresh(): void {
  if (deltaTimer) return;
  const MIN_INTERVAL_MS = 20 * 3600 * 1000; // at most ~1x/day, even if we restart often
  const tick = async () => {
    try {
      await ensureCatalogComplete(); // catches up an incomplete catalog, whatever happens
      // DMCA/delisted sets are invisible to the search enumeration: once it is
      // done, import any set from the shipped known-sets list that is missing.
      const diffs = (
        getDb()
          .prepare("SELECT COUNT(*) c FROM beatmaps WHERE ruleset = 0")
          .get() as { c: number }
      ).c;
      if (diffs >= MIN_EXPECTED_STD_DIFFS) {
        void importMissingKnownSets();
        // background fill of enrichment gaps (max_combo, and the MD5 checksums
        // added for collection export on DBs enriched before that column)
        if (!enrichCatchupRunning && !status.backfill.running) {
          enrichCatchupRunning = true;
          void enrichMaxCombo(enrichProgress)
            .catch((e) => logError(e, "background enrichment"))
            .finally(() => {
              enrichCatchupRunning = false;
            });
        }
      }
      // snipe check: re-check my country #1s older than the configured delay
      if (isUserConnected()) {
        // maps with a fresh score still awaiting their country check: high
        // priority, ahead of the low-priority sweep
        await confirmRecentCountryChecks();
        getDb()
          .prepare(
            `UPDATE beatmap_user SET country_checked_at = NULL
             WHERE country_first = 1
               AND country_checked_at < datetime('now', '-' || ? || ' hours')`
          )
          .run(getCountryRecheckHours());
        void runCountrySweep();
      }
      const last = getState("catalog_delta_at");
      if (last && Date.now() - Date.parse(last) < MIN_INTERVAL_MS) return;
      await refreshCatalogDelta();
    } catch (e) {
      logError(e, "periodic task (delta/snipe-check, will retry in 6 h)");
    }
  };
  setTimeout(() => void tick(), 60_000); // 1 min after startup
  deltaTimer = setInterval(() => void tick(), 6 * 3600 * 1000); // re-check every 6h
}

// ---------- Country leaderboard sweep: my country #1s ----------

let countryWanted = false;
let countryRunning = false;

/**
 * Deferred confirmation after a new score: osu!'s leaderboard can take a
 * moment to include a fresh submit, so an immediate "not #1" result may be
 * stale. One re-check ~2 min later catches the propagation lag (without it,
 * the map would be stamped as checked and never revisited, since the periodic
 * snipe re-check only targets maps where country_first = 1).
 */
const COUNTRY_CONFIRM_DELAY_MS = 2 * 60_000;

function scheduleCountryConfirm(beatmapId: number): void {
  const t = setTimeout(() => {
    if (!isUserConnected()) return;
    getCountryTop(beatmapId, "high")
      .then((top) => applyCountryCheck(beatmapId, top, true))
      .catch((e) => logError(e, `deferred country check map ${beatmapId}`));
  }, COUNTRY_CONFIRM_DELAY_MS);
  t.unref(); // never keeps the process alive
}

/**
 * HIGH-priority pass over pending country checks on maps with a recent score:
 * the deferred-confirm timer is lost on a restart, and the background sweep
 * would only reach these maps at low priority behind the whole queue. Runs at
 * each periodic tick (1 min after startup, then every 6 h); cheap when empty.
 */
export async function confirmRecentCountryChecks(): Promise<void> {
  if (!isUserConnected()) return;
  const rows = getDb()
    .prepare(
      `SELECT u.beatmap_id AS id FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE u.played = 1 AND u.country_checked_at IS NULL AND b.ruleset = 0
         AND EXISTS (
           SELECT 1 FROM scores s
           WHERE s.beatmap_id = u.beatmap_id
             AND datetime(s.ended_at) >= datetime('now', '-2 days'))
       LIMIT 100`
    )
    .all() as { id: number }[];
  for (const { id } of rows) {
    try {
      const top = await getCountryTop(id, "high");
      applyCountryCheck(id, top, true);
      logActivity(
        "country #1",
        () =>
          `${mapLabel(id)} — fresh-score recheck: ${
            top && top.user_id === config.osuUserId ? "#1 ✓" : "not #1"
          }`
      );
    } catch (e) {
      logError(e, `fresh-score country check map ${id}`);
      const msg = String(e);
      if (msg.includes("not connected") || msg.includes("supporter")) break;
    }
  }
}

/**
 * Applies the result of a country leaderboard check and logs the transitions
 * (gained/lost) into country_events.
 * `recordInitial`: also logs taking a #1 on a never-checked map (the case of
 * the immediate check after a new score); the initial sweep, in contrast, sets
 * the state silently so as not to flood the history.
 */
export function applyCountryCheck(
  beatmapId: number,
  top: import("../osu/types.js").SoloScore | null,
  recordInitial: boolean
): void {
  const db = getDb();
  const prev = db
    .prepare(
      "SELECT country_first, country_checked_at FROM beatmap_user WHERE beatmap_id = ?"
    )
    .get(beatmapId) as
    | { country_first: number; country_checked_at: string | null }
    | undefined;
  const isFirst = top && top.user_id === config.osuUserId ? 1 : 0;
  const wasChecked = prev?.country_checked_at != null;
  const prevFirst = prev?.country_first ?? 0;

  // Losing a held #1 is ALWAYS logged (country_first=1 implies a check had
  // established it, even if country_checked_at was reset to NULL for the re-check).
  // Gains stay silent during the initial sweep.
  const shouldRecord = prevFirst === 1 || wasChecked || recordInitial;
  if (shouldRecord && prevFirst !== isFirst) {
    db.prepare(
      `INSERT INTO country_events (beatmap_id, event, at, score_at, by_user_id, by_username)
       VALUES (?, ?, datetime('now'), ?, ?, ?)`
    ).run(
      beatmapId,
      isFirst ? "gained" : "lost",
      // real date of the score that took the #1 (mine or the sniper's)
      top?.ended_at ?? null,
      isFirst ? null : top?.user_id ?? null,
      isFirst ? null : top?.user?.username ?? null
    );
  }
  db.prepare(
    "UPDATE beatmap_user SET country_first = ?, country_checked_at = datetime('now') WHERE beatmap_id = ?"
  ).run(isFirst, beatmapId);
}

/**
 * Checks the country leaderboard of each played, not-yet-checked map
 * (country_checked_at NULL) and marks country_first if I hold the top.
 * Resumable, low priority, requires a connected account (+supporter).
 */
export async function runCountrySweep(force = false): Promise<void> {
  if (countryRunning) return;
  // The full sweep and the backfill both consume the same 60 req/min budget:
  // interleaving them doubles the duration of BOTH. Automatic starts (periodic
  // tick, auth callback) are deferred while the backfill runs — the sweep is
  // launched as soon as the backfill completes. Manual starts (menu) force.
  if (!force && status.backfill.running) {
    logActivity(
      "country #1",
      "sweep deferred until the backfill completes (shared rate limit)"
    );
    return;
  }
  countryRunning = true;
  countryWanted = true;
  try {
    const db = getDb();
    const nextBatch = db.prepare(
      `SELECT u.beatmap_id AS id FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE u.played = 1 AND u.country_checked_at IS NULL AND b.ruleset = 0
       ORDER BY u.country_first DESC, u.beatmap_id
       LIMIT 200`
    );
    let done = 0;
    while (countryWanted) {
      const ids = (nextBatch.all() as { id: number }[]).map((r) => r.id);
      if (ids.length === 0) break;
      for (const id of ids) {
        if (!countryWanted) break;
        try {
          const top = await getCountryTop(id, "low");
          const cc = getStoredCountryCode();
          applyCountryCheck(id, top, false);
          done++;
          logActivity(
              `${cc ? `#1 ${cc}` : "country #1"} sweep`,
            () =>
              `${mapLabel(id)} — ${
                top && top.user_id === config.osuUserId
                  ? "#1 ✓"
                  : top
                    ? `#1: ${top.user?.username ?? "?"}`
                    : "no country score"
              }`
          );
          if (done % 25 === 0)
            status.message = `${cc ? `#1 ${cc}` : "country #1"} sweep: ${done} maps checked...`;
        } catch (e) {
          logError(e, `country sweep map ${id}`);
          const msg = String(e);
          // no connected account or no supporter: no point insisting
          if (msg.includes("not connected") || msg.includes("supporter")) {
            countryWanted = false;
            break;
          }
        }
      }
    }
    if (done > 0) console.log(`[sync] country sweep: ${done} maps checked`);
  } finally {
    countryRunning = false;
  }
}

export function pauseCountrySweep(): void {
  countryWanted = false;
}

/**
 * Known-sets catch-up: seed-sets.json (shipped with the repo) lists every
 * ranked/approved/loved std set known from a complete reference catalog —
 * including DMCA/delisted sets that /beatmapsets/search never returns. Any set
 * missing locally is imported by direct lookup (API then web page). Runs after
 * the search enumeration is done; no-op once the catalog is complete.
 */
let seedRunning = false;

export async function importMissingKnownSets(): Promise<number> {
  if (seedRunning) return 0;
  seedRunning = true;
  try {
    const seedPath = path.join(__dirname, "../db/seed-sets.json");
    if (!fs.existsSync(seedPath)) return 0;
    const known = JSON.parse(fs.readFileSync(seedPath, "utf8")) as number[];
    const db = getDb();
    const have = new Set(
      (db.prepare("SELECT id FROM beatmapsets").all() as { id: number }[]).map(
        (r) => r.id
      )
    );
    const missing = known.filter((id) => !have.has(id));
    if (missing.length === 0) return 0;

    console.log(`[sync] known-sets catch-up: ${missing.length} sets missing`);
    let imported = 0;
    let failures = 0;
    for (const id of missing) {
      try {
        const r = await importSetById(id);
        imported += r.newDiffs;
        failures = 0;
        logActivity(
          "catalog",
          `known-sets catch-up: set ${id} (${r.source ?? "not found"}, +${r.newDiffs} diffs)`
        );
        status.message = `known-sets catch-up: ${imported} diffs imported...`;
      } catch (e) {
        logError(e, `known-sets catch-up: set ${id}`);
        if (++failures >= 10) break; // API down / auth issue: retry next tick
      }
    }
    if (imported > 0) {
      await enrichMaxCombo(enrichProgress);
      status.message = `known-sets catch-up done: +${imported} diffs.`;
    }
    return imported;
  } finally {
    seedRunning = false;
  }
}

/** Manual import of a set (API then web page) + backfill of its diffs. */
export async function importSetById(
  setId: number
): Promise<{ source: "api" | "web" | null; newDiffs: number }> {
  const { source, newIds } = await importOneSet(setId);
  for (const id of newIds) {
    try {
      const scores = await getUserBeatmapScores(id, config.osuUserId, "high");
      if (scores.length === 0) markFetchedEmpty(id);
      else saveScores(id, scores);
    } catch (e) {
      logError(e, `import set ${setId}: backfill map ${id}`);
    }
  }
  return { source, newDiffs: newIds.length };
}

/** Targeted year verification (search vs local DB) + backfill. */
export async function verifyYearAndBackfill(year: number) {
  const result = await verifyYear(year, (m) => (status.message = m));
  if (result.newBeatmapIds.length > 0) {
    await enrichMaxCombo(enrichProgress);
    for (const id of result.newBeatmapIds) {
      try {
        const scores = await getUserBeatmapScores(id, config.osuUserId, "low");
        if (scores.length === 0) markFetchedEmpty(id);
        else saveScores(id, scores);
      } catch (e) {
        logError(e, `verify-year: backfill map ${id}`);
      }
    }
  }
  status.message = `verify ${year} done: +${result.newBeatmapIds.length} diffs.`;
  return result;
}

/** Manual repair of mega-collabs (>100 diffs) + backfill of the new ones. */
export async function runBigSetsRepair(): Promise<number> {
  const newIds = await repairOversizedSets((m) => (status.message = m));
  if (newIds.length > 0) {
    await enrichMaxCombo(enrichProgress);
    for (const id of newIds) {
      try {
        const scores = await getUserBeatmapScores(id, config.osuUserId, "low");
        if (scores.length === 0) markFetchedEmpty(id);
        else saveScores(id, scores);
      } catch (e) {
        logError(e, `big-sets: backfill map ${id}`);
      }
    }
  }
  console.log(`[sync] big-sets: +${newIds.length} diffs`);
  return newIds.length;
}

// ---------- Initial pipeline (catalog, enrichment, backfill) ----------

export async function runPipeline(opts?: { skipCatalog?: boolean }) {
  try {
    const db = getDb();
    const hasCatalog =
      (db.prepare("SELECT COUNT(*) c FROM beatmaps").get() as { c: number }).c > 0;

    if (!opts?.skipCatalog && (!hasCatalog || !getState("catalog_imported_at"))) {
      status.phase = "catalog";
      status.message = "Importing beatmap catalog from the osu! API...";
      await importCatalogFromApi((m) => {
        status.message = m;
        logActivity("catalog", m);
      });
    }

    status.phase = "enrich";
    status.message = "Enriching max combo / star rating (API, 50 maps/req)...";
    await enrichMaxCombo(enrichProgress);

    status.phase = "backfill";
    backfillWanted = true;
    await runBackfill();
    status.phase = "done";
    status.message = "Initial sync complete. Polling continues in the background.";
  } catch (e) {
    status.phase = "error";
    status.message = e instanceof Error ? e.message : String(e);
    logError(e);
  }
}

export function pauseBackfill(): void {
  backfillWanted = false;
}

export async function resumeBackfill(): Promise<void> {
  if (status.backfill.running) return;
  backfillWanted = true;
  await runBackfill();
}

async function runBackfill(): Promise<void> {
  const db = getDb();
  status.backfill.running = true;
  status.message = "Score backfill in progress (resumable, ~40h the first time)...";
  try {
    const nextBatch = db.prepare(
      `SELECT b.id FROM beatmaps b
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       WHERE b.ruleset = 0 AND u.fetched_at IS NULL
       ORDER BY b.id
       LIMIT 200`
    );
    let completed = false;
    while (backfillWanted) {
      const ids = (nextBatch.all() as { id: number }[]).map((r) => r.id);
      if (ids.length === 0) {
        completed = true;
        break;
      }
      for (const id of ids) {
        if (!backfillWanted) break;
        try {
          const scores = await getUserBeatmapScores(id, config.osuUserId, "low");
          if (scores.length === 0) markFetchedEmpty(id);
          else saveScores(id, scores);
          logActivity(
            "backfill",
            () =>
              `${mapLabel(id)}${scores.length ? ` — ${scores.length} score(s)` : ""}`
          );
        } catch (e) {
          // we log and continue: the map will be retried (fetched_at NULL)
          logError(e, `backfill map ${id}`);
        }
      }
    }
    // Backfill done => start the country sweep that was deferred meanwhile
    // (automatic starts skip while the backfill holds the rate budget).
    if (completed && isUserConnected()) {
      status.backfill.running = false;
      void runCountrySweep();
    }
  } finally {
    status.backfill.running = false;
  }
}

/**
 * Recomputes the bests (and any_fc/played flags) of every map with scores —
 * catch-up after a logic change or scores imported by an older server version.
 */
export function recomputeAllBests(): number {
  const db = getDb();
  const ids = db
    .prepare("SELECT DISTINCT beatmap_id AS id FROM scores")
    .all() as { id: number }[];
  // markFetched: false => we preserve each map's backfill state
  for (const { id } of ids) refreshBest(id, false);
  return ids.length;
}
