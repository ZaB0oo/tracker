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
  getCountryTopScores,
  getModdedStarRating,
  getRecentScores,
  getUserBeatmapPosition,
  getStoredCountryCode,
  getUserBeatmapScores,
  isUserConnected,
  limiter,
} from "../osu/api.js";
import { markFetchedEmpty, saveScores, refreshBest } from "../logic/repo.js";
import type { SoloScore } from "../osu/types.js";
import {
  getDiscordSettings,
  notifyBests,
  type BestEvent,
} from "../notify/discord.js";
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

/** score mods JSON (lazer format: [{acronym: "HD"}, …]) → acronym list */
function parseModAcronyms(json: string): string[] {
  try {
    const arr = JSON.parse(json) as { acronym?: string }[];
    return arr.map((m) => m.acronym ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

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
let catalogRunning = false;

export function getDaemonStatus(): DaemonStatus & {
  busy: string[];
  sweeps: {
    country: boolean;
    countryChecked: number;
    countryPending: number;
    global: boolean;
    globalTracking: boolean;
    globalChecked: number;
    globalPending: number;
  };
} {
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
  if (status.phase === "catalog" || catalogRunning) busy.push("catalog import");
  if (status.phase === "enrich" || enrichCatchupRunning) busy.push("enrichment");
  if (seedRunning) busy.push("known-sets import");
  if (status.backfill.running) busy.push("backfill");
  if (countryRunning) {
    const cc = getStoredCountryCode();
    busy.push(`${cc ? `#1 ${cc}` : "country #1"} sweep`);
  }
  if (globalRunning) busy.push("global tops sweep");
  if (deltaRunning) busy.push("new maps");
  // Same scope as the sweep queues (catalog maps only): a stray beatmap_user
  // row outside ranked/approved/loved must not inflate the totals.
  const sweepCount = (cond: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) c FROM beatmap_user u
           JOIN beatmaps b ON b.id = u.beatmap_id
           WHERE u.played = 1 AND b.ruleset = 0 AND b.status IN (1, 2, 4)
             AND ${cond}`
        )
        .get() as { c: number }
    ).c;
  // In steady state only the held tops cycle (periodic re-checks), so the
  // button progress uses that scope: country #1s / global top-100s. When the
  // pending queue clearly exceeds it (initial sweep, "re-check all"), the
  // full played-maps scope is shown instead. Small overshoots (fresh-score
  // invalidations) don't flip the display.
  const BIG_SWEEP = 100;
  const progress = (checkedAtCol: string, scope: string) => {
    const pendingAll = sweepCount(`u.${checkedAtCol} IS NULL`);
    const pendingScoped = sweepCount(`u.${checkedAtCol} IS NULL AND ${scope}`);
    if (pendingAll - pendingScoped > BIG_SWEEP)
      return {
        checked: sweepCount(`u.${checkedAtCol} IS NOT NULL`),
        pending: pendingAll,
      };
    return {
      checked: sweepCount(`u.${checkedAtCol} IS NOT NULL AND ${scope}`),
      pending: pendingScoped,
    };
  };
  const country = progress("country_checked_at", "u.country_first = 1");
  const global = progress(
    "global_checked_at",
    "u.global_rank IS NOT NULL AND u.global_rank <= 100"
  );
  // "error" only reflects a past pipeline failure: once the error list is
  // cleared (UI button), stop displaying it forever.
  const phase =
    status.phase === "error" && status.errors.length === 0 ? "idle" : status.phase;
  return {
    ...status,
    phase,
    busy,
    sweeps: {
      country: countryRunning,
      global: globalRunning,
      globalTracking: isGlobalTrackingEnabled(),
      globalChecked: global.checked,
      globalPending: global.pending,
      countryChecked: country.checked,
      countryPending: country.pending,
    },
  };
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

/**
 * Fetch and store my full score list for one map. Errors are logged and
 * swallowed: the map keeps fetched_at NULL and will be retried later.
 * Returns the fetched scores, or null on failure.
 */
async function backfillMap(
  beatmapId: number,
  priority: "high" | "low",
  errCtx: string
): Promise<SoloScore[] | null> {
  try {
    const scores = await getUserBeatmapScores(beatmapId, config.osuUserId, priority);
    if (scores.length === 0) markFetchedEmpty(beatmapId);
    else saveScores(beatmapId, scores);
    return scores;
  } catch (e) {
    logError(e, errCtx);
    return null;
  }
}

/** Country checks need a connected account with supporter: once that error
 * shows up, stop the pass instead of failing on every remaining map. */
function isCountryAuthError(e: unknown): boolean {
  const msg = String(e);
  return msg.includes("not connected") || msg.includes("supporter");
}

// ---------- Polling (high priority) ----------

// Out-of-scope plays (graveyard/WIP maps) are not stored, so the same recent
// scores would look "fresh" on every poll for 24 h: remember them for the
// session to log once and stop re-attempting set imports.
const outOfScopeScoreIds = new Set<number>();
const unimportableMapIds = new Set<number>();

export async function pollRecentScores(): Promise<number> {
  if (outOfScopeScoreIds.size > 10_000) outOfScopeScoreIds.clear();
  if (unimportableMapIds.size > 10_000) unimportableMapIds.clear();
  let offset = 0;
  let newCount = 0;
  const byBeatmap = new Map<number, SoloScore[]>();
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

  // Snapshot BEFORE any catalog import below: which scores are new, and each
  // map's played/best state. The full-set import of a brand-new map backfills
  // its scores immediately — without this snapshot, the loop below would see
  // nothing "fresh" on it and its best would never notify.
  const exists = db.prepare("SELECT 1 FROM scores WHERE id = ?");
  const preStateStmt = db.prepare(
    "SELECT played, best_lazer_score_id AS best FROM beatmap_user WHERE beatmap_id = ?"
  );
  const freshByMap = new Map<number, SoloScore[]>();
  const preState = new Map<
    number,
    { played: number; best: number | null } | undefined
  >();
  for (const [beatmapId, scores] of byBeatmap) {
    const fresh = scores.filter(
      (s) => !exists.get(s.id) && !outOfScopeScoreIds.has(s.id)
    );
    if (fresh.length === 0) continue;
    freshByMap.set(beatmapId, fresh);
    preState.set(
      beatmapId,
      preStateStmt.get(beatmapId) as
        | { played: number; best: number | null }
        | undefined
    );
  }

  // Maps absent from the catalog (just ranked, or catalog not imported yet):
  // we import the FULL MAPSET (all diffs, not just the played diff), with
  // backfill of any scores on the other diffs.
  const knownMap = db.prepare("SELECT 1 FROM beatmaps WHERE id = ?");
  const unknown = [...byBeatmap.keys()].filter(
    (id) => !knownMap.get(id) && !unimportableMapIds.has(id)
  );
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

  const freshBeatmapIds: number[] = [];
  const bestEvents: BestEvent[] = [];
  const bestRow = db.prepare(
    `SELECT rank, accuracy, fc_state,
            COALESCE(classic_total_score, total_score) AS score,
            max_combo AS combo, pp, mods, statistics, ended_at
     FROM scores WHERE id = ?`
  );
  const statusStmt = db.prepare("SELECT status FROM beatmaps WHERE id = ?");
  for (const [beatmapId, fresh] of freshByMap) {
    // Graveyard/WIP/qualified plays are NOT stored at all: osu! wipes them
    // when the map gets ranked/loved (you must replay it), so storing them
    // would create phantom clears the day the status flips.
    const st = (statusStmt.get(beatmapId) as { status: number } | undefined)?.status;
    if (!(st === 1 || st === 2 || st === 4)) {
      // remember them: logged once, then silent for the session
      for (const s of fresh) outOfScopeScoreIds.add(s.id);
      if (st == null) unimportableMapIds.add(beatmapId);
      logActivity(
        "poll",
        () => `${mapLabel(beatmapId)} — ${fresh.length} score(s) on an unranked map (ignored)`
      );
      continue;
    }
    newCount += fresh.length;
    // markFetched: false => the map stays in the backfill queue, which will
    // later fetch the FULL list (old bests included)
    const result = saveScores(beatmapId, fresh, { markFetched: false });
    logActivity(
      "poll",
      () => `${mapLabel(beatmapId)} — ${fresh.length} new score(s)`
    );
    freshBeatmapIds.push(beatmapId);
    // Discord: only new BESTS (first clear or improvement), only via polling.
    // Compared against the PRE-import snapshot, so a best on a map imported
    // by this very tick (score saved during the set import) is seen too.
    const pre = preState.get(beatmapId);
    const bestId = result.bestScoreId;
    if (bestId != null && bestId !== (pre?.best ?? null)) {
      const s = bestRow.get(bestId) as
        | {
            rank: string;
            accuracy: number;
            fc_state: number;
            score: number;
            combo: number;
            pp: number | null;
            mods: string;
            statistics: string;
            ended_at: string;
          }
        | undefined;
      if (s)
        bestEvents.push({
          beatmapId,
          firstClear: !(pre?.played === 1),
          grade: s.rank,
          accuracy: s.accuracy,
          fcState: s.fc_state,
          score: s.score,
          combo: s.combo,
          pp: s.pp,
          endedAt: s.ended_at,
          modsJson: s.mods,
          statisticsJson: s.statistics,
          moddedSr: null,
          globalRank: null,
        });
    }
  }

  // New score => IMMEDIATE country leaderboard check at high priority (without
  // it, the map would wait its turn behind the whole initial sweep).
  if (freshBeatmapIds.length > 0 && isUserConnected()) {
    const invalidateCountry = db.prepare(
      "UPDATE beatmap_user SET country_checked_at = NULL WHERE beatmap_id = ?"
    );
    for (const id of freshBeatmapIds) {
      try {
        // Read BEFORE applyCountryCheck stamps the new state: improving my own
        // held #1 must not display the current runner-up as "sniped".
        const wasFirst =
          (
            db
              .prepare("SELECT country_first FROM beatmap_user WHERE beatmap_id = ?")
              .get(id) as { country_first: number } | undefined
          )?.country_first === 1;
        const countryScores = await getCountryTopScores(id, "high");
        const top = countryScores[0] ?? null;
        applyCountryCheck(id, top, true);
        // Discord: mark the best as "country #1 at submit time" (display only,
        // no country event notifications). The runner-up is the previous
        // holder — the player this score just sniped.
        if (top && top.user_id === config.osuUserId) {
          const best = bestEvents.find((b) => b.beatmapId === id);
          if (best) {
            best.countryFirst = true;
            best.snipedUsername = wasFirst
              ? null
              : countryScores[1]?.user?.username ?? null;
          }
        }
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
        if (isCountryAuthError(e)) break;
      }
    }
  }
  // Per-best enrichment:
  // - global leaderboard position: IMMEDIATE check for every new best (like
  //   the country one, and regardless of the sweep/tracking state) — the
  //   global tops stay current and the notification shows the rank when <= 100;
  // - SR with the play's mods (Discord display only).
  const discord = getDiscordSettings();
  const discordOn = discord.webhookSet && discord.bests;
  if (bestEvents.length > 0) {
    // mods that change star rating (osu! DifficultyAdjustmentMods — HD counts
    // since the 2026 reading rework)
    const DIFF_MODS = new Set(["DT", "NC", "HT", "DC", "HR", "EZ", "FL", "HD", "TD"]);
    for (const e of bestEvents) {
      if (discordOn) {
        const acronyms = parseModAcronyms(e.modsJson).filter((a) => a !== "CL");
        if (acronyms.some((a) => DIFF_MODS.has(a)))
          e.moddedSr = await getModdedStarRating(e.beatmapId, acronyms, "high");
      }
      try {
        e.globalRank = await getUserBeatmapPosition(e.beatmapId, config.osuUserId, "high");
        applyGlobalCheck(e.beatmapId, e.globalRank, true);
        // the leaderboard may not include the fresh score yet: confirm later
        scheduleGlobalConfirm(e.beatmapId);
      } catch (err) {
        // failed check: back into the sweep queue, it will retry
        logError(err, `position check map ${e.beatmapId}`);
        db.prepare(
          "UPDATE beatmap_user SET global_checked_at = NULL WHERE beatmap_id = ?"
        ).run(e.beatmapId);
      }
    }
  }
  notifyBests(bestEvents);
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
  const tick = () => {
    // no credentials yet (first launch, UI settings not filled): stay quiet
    // instead of spamming an error every interval
    if (!config.hasCredentials) return;
    // catalog import in progress: nothing else runs (the poll would race the
    // enumeration on set imports and steal its budget; scores from the 24 h
    // window are caught up right after)
    if (catalogRunning || status.phase === "catalog") return;
    void pollRecentScores().catch((e) =>
      logError(e, "poll of recent scores (will retry on the next tick)")
    );
  };
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
  // the pipeline (or a previous call) is already importing: don't run twice
  if (catalogRunning || status.phase === "catalog") return 0;

  catalogRunning = true;
  try {
    return await ensureCatalogCompleteInner(force, before, count);
  } finally {
    catalogRunning = false;
  }
}

async function ensureCatalogCompleteInner(
  force: boolean,
  before: number,
  count: () => number
): Promise<number> {
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
    for (const id of newIds)
      await backfillMap(id, "low", `delta: backfill map ${id}`);
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
    if (!config.hasCredentials) return; // first launch: nothing to do yet
    try {
      await ensureCatalogComplete(); // catches up an incomplete catalog, whatever happens
      // a catalog import is running (pipeline): everything else waits for it
      if (catalogRunning || status.phase === "catalog") return;
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
      // global tops: re-check held top-100 positions older than the delay,
      // then resume the sweep (no-op when the queue is empty)
      if (isGlobalTrackingEnabled()) {
        const gdb = getDb();
        gdb
          .prepare(
            `UPDATE beatmap_user SET global_checked_at = NULL
             WHERE global_rank IS NOT NULL AND global_rank <= 100
               AND global_checked_at < datetime('now', '-' || ? || ' hours')`
          )
          .run(getGlobalRecheckHours());
        // Repair pass (mirrors the country one): a position stamped within
        // 15 min of one of my recent scores may predate the leaderboard
        // update — and the deferred-confirm timer does not survive a restart.
        gdb.exec(
          `UPDATE beatmap_user SET global_checked_at = NULL
           WHERE global_checked_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM scores s
             WHERE s.beatmap_id = beatmap_user.beatmap_id
               AND datetime(s.ended_at) >= datetime('now', '-2 days')
               AND datetime(beatmap_user.global_checked_at) <= datetime(s.ended_at, '+15 minutes'))`
        );
        void runGlobalSweep();
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
          } (${getStoredCountryCode() ?? "country"})`
      );
    } catch (e) {
      logError(e, `fresh-score country check map ${id}`);
      if (isCountryAuthError(e)) break;
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
  top: SoloScore | null,
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
  if (!force && (status.backfill.running || catalogRunning || status.phase === "catalog")) {
    logActivity(
      "country #1",
      "sweep deferred until the catalog/backfill completes (shared rate limit)"
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
              } (${cc ?? "country"})`
          );
          if (done % 25 === 0)
            status.message = `${cc ? `#1 ${cc}` : "country #1"} sweep: ${done} maps checked...`;
        } catch (e) {
          logError(e, `country sweep map ${id}`);
          // no connected account or no supporter: no point insisting
          if (isCountryAuthError(e)) {
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

// ---------- Global leaderboard sweep: my top 1/8/15/25/50/100 positions ----------

let globalWanted = false;
let globalRunning = false;

export function isGlobalTrackingEnabled(): boolean {
  return getState("global_tracking") === "1";
}

const GLOBAL_TIERS = [1, 8, 15, 25, 50, 100];

/** Smallest tracked tier containing the rank (8 for #5), null beyond top 100. */
function globalTier(rank: number | null): number | null {
  if (rank == null) return null;
  for (const t of GLOBAL_TIERS) if (rank <= t) return t;
  return null;
}

/**
 * Stores a global position check and logs a history event when the map
 * changes TIER (top 1/8/15/25/50/100) — rank moves inside a tier are not
 * events. First-ever checks stay silent (initial sweep) unless
 * `recordInitial` is set (immediate check after a NEW score: entering a tier
 * on a never-checked map is a real gain, same rule as the country checks).
 */
export function applyGlobalCheck(
  beatmapId: number,
  pos: number | null,
  recordInitial = false
): void {
  const db = getDb();
  const prev = db
    .prepare(
      "SELECT global_rank, global_checked_at, global_seen FROM beatmap_user WHERE beatmap_id = ?"
    )
    .get(beatmapId) as
    | {
        global_rank: number | null;
        global_checked_at: string | null;
        global_seen: number;
      }
    | undefined;
  const prevRank = prev?.global_rank ?? null;
  // "known" = a previous check happened — global_seen survives the re-queues
  // that reset global_checked_at, so re-check transitions are always logged
  const wasKnown =
    prevRank != null || prev?.global_checked_at != null || prev?.global_seen === 1;
  const oldTier = globalTier(prevRank);
  const newTier = globalTier(pos);
  if ((wasKnown || recordInitial) && oldTier !== newTier) {
    db.prepare(
      "INSERT INTO global_events (beatmap_id, at, old_rank, new_rank) VALUES (?, datetime('now'), ?, ?)"
    ).run(beatmapId, prevRank, pos);
    logActivity(
      "global tops",
      () =>
        `${mapLabel(beatmapId)} — ${oldTier ? `top ${oldTier}` : "outside top 100"} → ${
          newTier ? `top ${newTier}` : "outside top 100"
        } (${prevRank != null ? `#${prevRank}` : "—"} → ${pos != null ? `#${pos}` : "—"}) (global)`
    );
  }
  db.prepare(
    "UPDATE beatmap_user SET global_rank = ?, global_checked_at = datetime('now'), global_seen = 1 WHERE beatmap_id = ?"
  ).run(pos, beatmapId);
}

/**
 * Deferred confirmation after a new best: like the country leaderboard, the
 * global one can lag behind a fresh submit — the immediate check may return
 * the OLD position (or none) and, when it lands outside the top 100, nothing
 * would ever re-check it. One re-check a few minutes later catches it.
 */
const GLOBAL_CONFIRM_DELAY_MS = 3 * 60_000;

function scheduleGlobalConfirm(beatmapId: number): void {
  const t = setTimeout(() => {
    if (!config.hasCredentials) return;
    getUserBeatmapPosition(beatmapId, config.osuUserId, "high")
      .then((pos) => applyGlobalCheck(beatmapId, pos, true))
      .catch((e) => logError(e, `deferred global check map ${beatmapId}`));
  }, GLOBAL_CONFIRM_DELAY_MS);
  t.unref(); // never keeps the process alive
}

/** Delay (hours) before re-checking a held top-100 position. */
export function getGlobalRecheckHours(): number {
  const v = Number(getState("global_recheck_hours"));
  return Number.isFinite(v) && v >= 1 ? Math.round(v) : 48;
}

/**
 * Checks my global leaderboard position on each played, not-yet-checked map
 * (global_checked_at NULL). Same architecture as the country sweep: resumable,
 * low priority, deferred while the backfill runs. Uses the client-credentials
 * API (no connected account required). Previously-ranked maps (re-checks) go
 * first — losing a top spot matters more than discovering a new #4000.
 */
export async function runGlobalSweep(force = false): Promise<void> {
  if (globalRunning) return;
  if (!force && (status.backfill.running || catalogRunning || status.phase === "catalog")) {
    logActivity(
      "global tops",
      "sweep deferred until the catalog/backfill completes (shared rate limit)"
    );
    return;
  }
  globalRunning = true;
  globalWanted = true;
  try {
    const db = getDb();
    const nextBatch = db.prepare(
      `SELECT u.beatmap_id AS id FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE u.played = 1 AND u.global_checked_at IS NULL AND b.ruleset = 0
       ORDER BY (u.global_rank IS NOT NULL) DESC, u.global_rank, u.beatmap_id
       LIMIT 200`
    );
    let done = 0;
    let failures = 0;
    while (globalWanted) {
      const ids = (nextBatch.all() as { id: number }[]).map((r) => r.id);
      if (ids.length === 0) break;
      for (const id of ids) {
        if (!globalWanted) break;
        try {
          const pos = await getUserBeatmapPosition(id, config.osuUserId, "low");
          applyGlobalCheck(id, pos);
          done++;
          failures = 0;
          logActivity(
            "global tops sweep",
            () => `${mapLabel(id)} — ${pos != null ? `#${pos}` : "not on leaderboard"} (global)`
          );
          if (done % 25 === 0)
            status.message = `global tops sweep: ${done} maps checked...`;
        } catch (e) {
          logError(e, `global sweep map ${id}`);
          if (++failures >= 10) {
            // API down: stop, the periodic tick will resume the sweep
            globalWanted = false;
            break;
          }
        }
      }
    }
    if (done > 0) console.log(`[sync] global tops sweep: ${done} maps checked`);
  } finally {
    globalRunning = false;
  }
}

export function pauseGlobalSweep(): void {
  globalWanted = false;
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
  for (const id of newIds)
    await backfillMap(id, "high", `import set ${setId}: backfill map ${id}`);
  return { source, newDiffs: newIds.length };
}

/** Targeted year verification (search vs local DB) + backfill. */
export async function verifyYearAndBackfill(year: number) {
  const result = await verifyYear(year, (m) => (status.message = m));
  if (result.newBeatmapIds.length > 0) {
    await enrichMaxCombo(enrichProgress);
    for (const id of result.newBeatmapIds)
      await backfillMap(id, "low", `verify-year: backfill map ${id}`);
  }
  status.message = `verify ${year} done: +${result.newBeatmapIds.length} diffs.`;
  return result;
}

/** Manual repair of mega-collabs (>100 diffs) + backfill of the new ones. */
export async function runBigSetsRepair(): Promise<number> {
  const newIds = await repairOversizedSets((m) => (status.message = m));
  if (newIds.length > 0) {
    await enrichMaxCombo(enrichProgress);
    for (const id of newIds)
      await backfillMap(id, "low", `big-sets: backfill map ${id}`);
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
      // Mutual exclusion with the background completion (periodic tick): two
      // concurrent enumerations would duplicate the work and burn API budget.
      while (catalogRunning) {
        status.message =
          "Catalog import already running in the background — waiting for it...";
        await new Promise((r) => setTimeout(r, 5000));
      }
      catalogRunning = true;
      try {
        status.message = "Importing beatmap catalog from the osu! API...";
        await importCatalogFromApi((m) => {
          status.message = m;
          logActivity("catalog", m);
        });
      } finally {
        catalogRunning = false;
      }
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
        const scores = await backfillMap(id, "low", `backfill map ${id}`);
        if (scores)
          logActivity(
            "backfill",
            () =>
              `${mapLabel(id)}${scores.length ? ` — ${scores.length} score(s)` : ""}`
          );
      }
    }
    // Backfill done => run the leaderboard passes that were deferred while it
    // held the rate budget: country sweep first (needs the connected
    // account), then the global tops sweep. Initial sync therefore chains
    // catalog -> scores -> country -> global tops.
    if (completed) {
      status.backfill.running = false;
      void (async () => {
        if (isUserConnected()) await runCountrySweep();
        if (isGlobalTrackingEnabled()) await runGlobalSweep();
      })();
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
