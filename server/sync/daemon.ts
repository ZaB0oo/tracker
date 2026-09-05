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
import { catalogRulesets, getActiveRulesets, getDb, getStartedRulesets, getState, setState, sqlIn } from "../db/db.js";
import {
  poolGrowth,
  rulesetDef,
  shortModeName,
  seedCounts,
  seedNeedsLookup,
  type SeedVersion,
} from "../logic/rulesets.js";
import {
  getBeatmapsByIds,
  getConvertAttrs,
  getCountryTop,
  getCountryTopScores,
  getRecentScores,
  getUserBeatmapPosition,
  getStoredCountryCode,
  getStoredProfile,
  profileKey,
  refreshStoredProfile,
  getUserBeatmapScores,
  isUserConnected,
  limiter,
} from "../osu/api.js";
import { markFetchedEmpty, recomputeFcForMap, saveScores, refreshBest } from "../logic/repo.js";
import { bumpScoresVersion } from "../logic/scoreSql.js";
import type { SoloScore } from "../osu/types.js";
import {
  getDiscordSettings,
  notifyBests,
  notifyCountryFirstLost,
  notifyGlobalTopLost,
  updateBestHonors,
  notifyMetricMilestones,
  type BestEvent,
} from "../notify/discord.js";
import {
  enrichMaxCombo,
  importCatalogFromApi,
  importOneSet,
  poolCounts,
  recheckDelistedSets,
  currentEnumMode,
  repairOversizedSets,
  updateCatalogDelta,
  verifyYear,
} from "./catalog.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { srMods, srModsKey } from "../logic/score.js";
import { localStarRating } from "../osu/difficulty.js";

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
// prepared once: this runs for every backfilled/swept/polled map — one SQL
// parse per API call adds up over hours-long passes
let mapLabelStmt: ReturnType<DatabaseLike["prepare"]> | null = null;
type DatabaseLike = ReturnType<typeof getDb>;
function mapLabel(beatmapId: number): string {
  mapLabelStmt ??= getDb().prepare(
    `SELECT st.artist || ' - ' || st.title || ' [' || b.version || ']' AS label
     FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
     WHERE b.id = ?`
  );
  const r = mapLabelStmt.get(beatmapId) as { label: string } | undefined;
  return r?.label ?? `map ${beatmapId}`;
}

/**
 * Live best feed for the UI (toast, tile pulse, desktop notification): the
 * same events the Discord path notifies, kept in a small ring buffer served
 * with the status. Ids are monotone within the process; the client keeps the
 * last id seen and only reacts to newer entries (and initialises to the
 * current max on load, so a page refresh never replays old bests).
 */
export interface BestFeedEntry {
  id: number;
  at: string;
  beatmapId: number;
  setId: number;
  ruleset: number;
  /** "Artist - Title [Diff]" */
  label: string;
  grade: string;
  accuracy: number;
  pp: number | null;
  firstClear: boolean;
  countryFirst: boolean;
  globalRank: number | null;
}

let bestFeedSeq = 0;
const bestFeed: BestFeedEntry[] = [];
const BEST_FEED_MAX = 50;

/** feed only carries bests that JUST happened: the toast is a "right now"
 * signal. After a restart or a long process, the poll catches up on scores
 * set while the app was busy or closed; toasting those minutes or hours
 * later reads as notifications firing "at the end of the process". Discord
 * keeps notifying them (its posts show the score's own timestamp). */
const BEST_FEED_FRESH_MS = 30 * 60_000;

function pushBestFeed(e: BestEvent): void {
  try {
    const age = Date.now() - Date.parse(e.endedAt);
    if (Number.isFinite(age) && age > BEST_FEED_FRESH_MS) return;
    const m = getDb()
      .prepare(
        `SELECT st.artist || ' - ' || st.title || ' [' || b.version || ']' AS label,
                b.beatmapset_id AS setId
         FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
         WHERE b.id = ?`
      )
      .get(e.beatmapId) as { label: string; setId: number } | undefined;
    bestFeed.push({
      id: ++bestFeedSeq,
      at: new Date().toISOString(),
      beatmapId: e.beatmapId,
      setId: m?.setId ?? 0,
      ruleset: e.ruleset,
      label: m?.label ?? `map ${e.beatmapId}`,
      grade: e.grade,
      accuracy: e.accuracy,
      pp: e.pp ?? e.ppLocal ?? null,
      firstClear: e.firstClear,
      countryFirst: e.countryFirst === true,
      globalRank: e.globalRank ?? null,
    });
    if (bestFeed.length > BEST_FEED_MAX)
      bestFeed.splice(0, bestFeed.length - BEST_FEED_MAX);
  } catch (err) {
    logError(err, `best feed map ${e.beatmapId}`);
  }
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
/** Persistent per-mode backfill pause: those passes are skipped. */
export function isBackfillModePaused(r: number): boolean {
  return getState(`backfill_paused_m${r}`) === "1";
}
let pollTimer: ReturnType<typeof setInterval> | null = null;
let deltaTimer: ReturnType<typeof setInterval> | null = null;
let enrichCatchupRunning = false;
let deltaRunning = false;
let catalogRunning = false;

interface RulesetProgress {
  ruleset: number;
  name: string;
  /** enabled in Settings (a disabled mode cannot be started) */
  active: boolean;
  started: boolean;
  backfillPaused: boolean;
  specificTotal: number;
  specificFetched: number;
  convertsTotal: number;
  convertsFetched: number;
}

// The UI polls the status every 2-5 s and the counters below are ~20
// aggregate scans over 150k+ row tables: memoized for 5 s. The staleness is
// invisible at that scale; the constant DB load competing with the sync
// writes was not.
let countersMemo: {
  at: number;
  total: number;
  fetched: number;
  country: { checked: number; pending: number };
  global: { checked: number; pending: number };
  rulesets: RulesetProgress[];
} | null = null;

export function getDaemonStatus(): DaemonStatus & {
  busy: string[];
  backfillPausedModes: number[];
  backfillPassRuleset: number | null;
  sweeps: {
    country: boolean;
    countryChecked: number;
    countryPending: number;
    global: boolean;
    globalTracking: boolean;
    globalChecked: number;
    globalPending: number;
  };
  rulesets: RulesetProgress[];
  bests: BestFeedEntry[];
} {
  const db = getDb();
  if (!countersMemo || Date.now() - countersMemo.at > 5000) {
    const total = (
      db.prepare("SELECT COUNT(*) c FROM beatmaps WHERE ruleset = 0").get() as {
        c: number;
      }
    ).c;
    const fetched = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM beatmaps b
           JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = 0
           WHERE b.ruleset = 0 AND u.fetched_at IS NOT NULL`
        )
        .get() as { c: number }
    ).c;
    countersMemo = {
      at: Date.now(),
      total,
      fetched,
      ...computeSweepAndRulesetCounters(db),
    };
  }
  status.backfill.total = countersMemo.total;
  status.backfill.fetched = countersMemo.fetched;
  status.queue = limiter.queueSizes;
  status.lastDeltaAt = getState("catalog_delta_at");

  // What is running RIGHT NOW (the old "phase" only covered the pipeline)
  const busy: string[] = [];
  busy.push(...maintenanceTasks);
  if (packsDeltaRunning) busy.push("packs delta");
  if (status.phase === "catalog" || catalogRunning) {
    const m = currentEnumMode();
    busy.push(
      m == null ? "catalog import" : `catalog import (${shortModeName(m)})`
    );
  }
  for (const m of queuedEnumModes)
    busy.push(`catalog import (${shortModeName(m)}) queued`);
  if (status.phase === "enrich" || enrichCatchupRunning)
    busy.push("map details (all modes)");
  if (seedRunning) busy.push("known-sets import (all modes)");
  if (status.backfill.running) busy.push(backfillPassLabel);
  if (countryRunning) {
    const cc = getStoredCountryCode();
    busy.push(`${cc ? `#1 ${cc}` : "country #1"} sweep (all modes)`);
  }
  if (globalRunning) busy.push("global tops sweep (all modes)");
  if (deltaRunning) busy.push("new maps (all modes)");
  const { country, global: globalProg } = countersMemo;
  // Only the COUNTs are memoized: active/started/paused drive UI buttons and
  // are re-read live, otherwise clicking "Start" left the button visible for
  // 5 s (and a second click started a second pipeline).
  const activeNow = getActiveRulesets();
  const rulesets: RulesetProgress[] = countersMemo.rulesets.map((r) => {
    const active = activeNow.includes(r.ruleset);
    return {
      ...r,
      active,
      started: active && getState(`ruleset_started_${r.ruleset}`) === "1",
      backfillPaused: active && isBackfillModePaused(r.ruleset),
    };
  });
  // "error" only reflects a past pipeline failure: once the error list is
  // cleared (UI button), stop displaying it forever.
  const phase =
    status.phase === "error" && status.errors.length === 0 ? "idle" : status.phase;
  // Per-ruleset backfill pause flags stay live (they gate UI buttons).
  const backfillPausedModes = [0, 1, 2, 3].filter(isBackfillModePaused);
  return {
    ...status,
    phase,
    busy,
    backfillPausedModes,
    backfillPassRuleset: status.backfill.running ? backfillPassRuleset : null,
    rulesets,
    bests: bestFeed,
    sweeps: {
      country: countryRunning,
      global: globalRunning,
      globalTracking: isGlobalTrackingEnabled(),
      globalChecked: globalProg.checked,
      globalPending: globalProg.pending,
      countryChecked: country.checked,
      countryPending: country.pending,
    },
  };
}

/** The heavy, memoized part of getDaemonStatus (see countersMemo). */
function computeSweepAndRulesetCounters(db: ReturnType<typeof getDb>): {
  country: { checked: number; pending: number };
  global: { checked: number; pending: number };
  rulesets: RulesetProgress[];
} {
  // Same scope as the sweep queues (catalog maps only): a stray beatmap_user
  // row outside ranked/approved/loved must not inflate the totals.
  const sweepCount = (cond: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) c FROM beatmap_user u
           JOIN beatmaps b ON b.id = u.beatmap_id
           WHERE u.played = 1 AND b.status IN (1, 2, 4)
             AND u.ruleset IN (${sqlIn(getStartedRulesets())})
             AND (b.ruleset = u.ruleset OR b.ruleset = 0)
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
  // All four modes, so the UI can offer (or grey out) each mode's start button.
  // Inactive modes report zeros instead of running four COUNTs for nothing.
  const active = getActiveRulesets();
  const rulesets: RulesetProgress[] = [0, 1, 2, 3].map((r) => {
    if (!active.includes(r))
      return {
        ruleset: r,
        name: shortModeName(r),
        active: false,
        started: false,
        backfillPaused: false,
        specificTotal: 0,
        specificFetched: 0,
        convertsTotal: 0,
        convertsFetched: 0,
      };
    const cnt = (mapMode: number, fetchedOnly: boolean) =>
      (
        db
          .prepare(
            `SELECT COUNT(*) c FROM beatmaps b
             ${fetchedOnly ? "JOIN" : "LEFT JOIN"} beatmap_user u
               ON u.beatmap_id = b.id AND u.ruleset = ${r}
             WHERE b.ruleset = ${mapMode}${fetchedOnly ? " AND u.fetched_at IS NOT NULL" : ""}`
          )
          .get() as { c: number }
      ).c;
    return {
      ruleset: r,
      name: shortModeName(r),
      active: true,
      started: getState(`ruleset_started_${r}`) === "1",
      backfillPaused: isBackfillModePaused(r),
      specificTotal: cnt(r, false),
      specificFetched: cnt(r, true),
      // a std map is not a convert of itself
      convertsTotal: r === 0 ? 0 : cnt(0, false),
      convertsFetched: r === 0 ? 0 : cnt(0, true),
    };
  });
  return { country, global, rulesets };
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
  logActivity("enrich", `${done}/${total} maps read (max combo, checksum)`);
};

/**
 * Fills what the search does not give: max_combo (FC reference, classic score,
 * combo filter) and the .osu checksum, 50 maps per request. Runs AFTER the
 * catalog is complete, so the map count is already final while it works.
 */
export async function enrichCatalog(): Promise<number> {
  // `phase` is the initial pipeline's own progress, and nothing else resets it:
  // a background pass that left it on "enrich" kept "map details" in the sync
  // bar for ever, even when the pass had nothing to read and returned at once.
  const prev = status.phase;
  status.phase = "enrich";
  try {
    return await enrichMaxCombo(enrichProgress);
  } finally {
    if (status.phase === "enrich") status.phase = prev;
  }
}

/**
 * Backfills one diff for EVERY started ruleset that can play it (its native
 * mode, plus the converts of a std map) — a single-mode fetch would miss the
 * other modes' scores on it.
 */
async function backfillMapAllModes(
  beatmapId: number,
  priority: "high" | "low",
  errCtx: string
): Promise<void> {
  const b = getDb()
    .prepare("SELECT ruleset FROM beatmaps WHERE id = ?")
    .get(beatmapId) as { ruleset: number } | undefined;
  if (!b) return;
  for (const r of getStartedRulesets())
    if (b.ruleset === r || b.ruleset === 0)
      await backfillMap(beatmapId, priority, errCtx, r);
}

/**
 * Fetch and store my full score list for one map. Errors are logged and
 * swallowed: the map keeps fetched_at NULL and will be retried later.
 * Returns the fetched scores, or null on failure.
 */
async function backfillMap(
  beatmapId: number,
  priority: "high" | "low",
  errCtx: string,
  ruleset = 0
): Promise<SoloScore[] | null> {
  try {
    const scores = await getUserBeatmapScores(
      beatmapId,
      config.osuUserId,
      priority,
      rulesetDef(ruleset).apiName
    );
    if (scores.length === 0) markFetchedEmpty(beatmapId, ruleset);
    else saveScores(beatmapId, scores, { ruleset });
    return scores;
  } catch (e) {
    logError(e, errCtx);
    return null;
  }
}

/**
 * Background fill of convert_attrs: per-mode star rating and max combo of the
 * PLAYED converts (1 request each, low priority, resumable — unplayed
 * converts keep the std values as approximation until played). Kicked by the
 * periodic tick and after each backfill completion.
 */
let convertAttrsRunning = false;
export async function fillConvertAttrs(): Promise<void> {
  if (convertAttrsRunning) return;
  const modes = getStartedRulesets().filter((r) => r !== 0);
  if (modes.length === 0) return;
  convertAttrsRunning = true;
  try {
    const db = getDb();
    const next = db.prepare(
      `SELECT u.beatmap_id AS id, u.ruleset AS r FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE u.played = 1 AND u.ruleset IN (${modes.join(",")}) AND b.ruleset = 0
         AND NOT EXISTS (SELECT 1 FROM convert_attrs ca
                         WHERE ca.beatmap_id = u.beatmap_id AND ca.ruleset = u.ruleset
                           -- max_combo = 0 was the "API said nothing" sentinel:
                           -- such rows must be re-fetched, not treated as done
                           AND ca.max_combo IS NOT NULL AND ca.max_combo > 0)
       LIMIT 100`
    );
    const ins = db.prepare(
      `INSERT OR REPLACE INTO convert_attrs (beatmap_id, ruleset, star_rating, max_combo, fetched_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    );
    let done = 0;
    for (;;) {
      const rows = next.all() as { id: number; r: number }[];
      if (rows.length === 0) break;
      for (const { id, r } of rows) {
        const a = await getConvertAttrs(id, rulesetDef(r).apiName, "low");
        if (!a) return; // API down: the next tick retries
        ins.run(id, r, a.starRating, a.maxCombo);
        // the FC reference just arrived: scores stored before it could never
        // resolve to PERFECT by combo — re-evaluate them now
        if (a.maxCombo != null) recomputeFcForMap(id, r);
        done++;
      }
      logActivity(
        "convert attrs",
        `${done} played convert(s) enriched (per-mode SR / max combo)`
      );
    }
  } finally {
    convertAttrsRunning = false;
  }
}

/**
 * The /beatmaps/{id}/scores endpoints have their OWN, much stricter
 * Cloudflare rule (~15-20 req/min tolerated in practice, on an hour-scale
 * bucket): running the sweeps at the full API rate tripped it every minute,
 * and each 429 slowed every other task through the global penalty. The
 * background sweeps therefore space their leaderboard checks — a shared gate,
 * as the country and global sweeps hit the same endpoint class. 12/min is
 * plenty: re-checking 20k held #1s every 48 h needs ~7/min on average.
 * Immediate post-score checks (1-2 maps) stay unspaced.
 */
const LB_SWEEP_SPACING_MS = 5000;
let lastLbSweepAt = 0;
async function lbSweepGate(): Promise<void> {
  const wait = lastLbSweepAt + LB_SWEEP_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLbSweepAt = Date.now();
}

/** Country checks need a connected account with supporter: once that error
 * shows up, stop the pass instead of failing on every remaining map. */
function isCountryAuthError(e: unknown): boolean {
  const msg = String(e);
  return (
    msg.includes("not connected") ||
    msg.includes("supporter") ||
    // oauth endpoint throttled or refresh cooling down: stop the pass, the
    // periodic tick will retry — iterating the queue would hammer oauth
    msg.includes("user oauth") ||
    msg.includes("backing off")
  );
}

// ---------- Polling (high priority) ----------

// Out-of-scope plays (graveyard/WIP maps) are not stored, so the same recent
// scores would look "fresh" on every poll for 24 h: remember them for the
// session to log once and stop re-attempting set imports.
const outOfScopeScoreIds = new Set<number>();
const unimportableMapIds = new Set<number>();

let pollRunning = false;

/** null = a pass was already running (the manual button says so instead of
 * reporting a misleading "0 new scores"). */
export async function pollRecentScores(): Promise<number | null> {
  // In-flight guard: a pass can outlive the poll interval (a brand-new set
  // means minutes of rate-limited backfill), and overlapping passes double
  // notifications, imports and checks.
  if (pollRunning) return null;
  pollRunning = true;
  try {
    // one pass per active ruleset — the recent endpoint is per mode
    let total = 0;
    for (const mode of getStartedRulesets())
      total += await pollRecentScoresForMode(mode);
    return total;
  } finally {
    pollRunning = false;
  }
}

async function pollRecentScoresForMode(mode: number): Promise<number> {
  if (outOfScopeScoreIds.size > 10_000) outOfScopeScoreIds.clear();
  if (unimportableMapIds.size > 10_000) unimportableMapIds.clear();
  let offset = 0;
  let newCount = 0;
  const byBeatmap = new Map<number, SoloScore[]>();
  for (;;) {
    const batch = await getRecentScores(
      config.osuUserId,
      50,
      offset,
      rulesetDef(mode).apiName
    );
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
  if (byBeatmap.size === 0) return 0;

  const db = getDb();

  // Snapshot BEFORE any catalog import below: which scores are new, and each
  // map's played/best state. The full-set import of a brand-new map backfills
  // its scores immediately — without this snapshot, the loop below would see
  // nothing "fresh" on it and its best would never notify.
  const exists = db.prepare("SELECT 1 FROM scores WHERE id = ?");
  const preStateStmt = db.prepare(
    `SELECT played, best_lazer_score_id AS best FROM beatmap_user WHERE beatmap_id = ? AND ruleset = ${mode}`
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
            total_score AS score_std,
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
        () => `${mapLabel(beatmapId)} · ${fresh.length} score(s) on an unranked map (ignored)`
      );
      continue;
    }
    newCount += fresh.length;
    // markFetched: false => the map stays in the backfill queue, which will
    // later fetch the FULL list (old bests included)
    const result = saveScores(beatmapId, fresh, {
      markFetched: false,
      ruleset: mode,
    });
    logActivity(
      "poll",
      () => `${mapLabel(beatmapId)} · ${fresh.length} new score(s)`
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
            score_std: number | null;
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
          ruleset: mode,
          firstClear: !(pre?.played === 1),
          grade: s.rank,
          accuracy: s.accuracy,
          fcState: s.fc_state,
          score: s.score,
          scoreStd: s.score_std,
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
      `UPDATE beatmap_user SET country_checked_at = NULL WHERE beatmap_id = ? AND ruleset = ${mode}`
    );
    for (const id of freshBeatmapIds) {
      try {
        // Read BEFORE applyCountryCheck stamps the new state: improving my own
        // held #1 must not display the current runner-up as "sniped".
        const wasFirst =
          (
            db
              .prepare(
                `SELECT country_first FROM beatmap_user WHERE beatmap_id = ? AND ruleset = ${mode}`
              )
              .get(id) as { country_first: number } | undefined
          )?.country_first === 1;
        const countryScores = await getCountryTopScores(
          id,
          "high",
          rulesetDef(mode).apiName
        );
        const top = countryScores[0] ?? null;
        const stillFirst = top != null && top.user_id === config.osuUserId;
        // The leaderboard can lag behind a fresh submit: right after MY OWN
        // score it may still show the previous holder. Applying that stale
        // "not #1" to a held #1 would record a false lost event (and, now
        // that losses notify, ping Discord with it), then a false "gained"
        // when the confirmation lands. Keep the held state untouched and let
        // the deferred confirm below decide whether the loss is real.
        if (!(wasFirst && !stillFirst)) applyCountryCheck(id, top, true, mode);
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
          scheduleCountryConfirm(id, mode);
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
  // any webhook subscribed to bests: the per-webhook flags are the routing
  const discordOn = discord.webhooks.some((w) => w.bests);
  if (bestEvents.length > 0) {
    for (const e of bestEvents) {
      if (discordOn) {
        // Rating for the mods as they were played, rate included, computed
        // from the .osu file: the API only knows the legacy mod combinations.
        const mods = srMods(e.modsJson);
        if (mods.length > 0) {
          // shared with the metrics view: read the modded_sr cache first and
          // store what gets computed (misses re-ran the whole computation on
          // every improved best of the same map+mods)
          const key = srModsKey(mods);
          const hit = getDb()
            .prepare(
              "SELECT star_rating FROM modded_sr WHERE beatmap_id = ? AND ruleset = ? AND mods = ?"
            )
            .get(e.beatmapId, mode, key) as
            | { star_rating: number | null }
            | undefined;
          if (hit) e.moddedSr = hit.star_rating;
          else {
            e.moddedSr = await localStarRating(e.beatmapId, mods, mode);
            getDb()
              .prepare(
                "INSERT OR REPLACE INTO modded_sr (beatmap_id, ruleset, mods, star_rating) VALUES (?, ?, ?, ?)"
              )
              .run(e.beatmapId, mode, key, e.moddedSr);
          }
        }
      }
      try {
        // read BEFORE the check stamps anything: needed by the lag guard below
        const prevGlobal =
          (
            db
              .prepare(
                `SELECT global_rank FROM beatmap_user WHERE beatmap_id = ? AND ruleset = ${mode}`
              )
              .get(e.beatmapId) as { global_rank: number | null } | undefined
          )?.global_rank ?? null;
        e.globalRank = await getUserBeatmapPosition(
          e.beatmapId,
          config.osuUserId,
          "high",
          rulesetDef(mode).apiName
        );
        // Same lag guard as the country check: right after my own score the
        // leaderboard can still miss it, and a held top-100 position would
        // read worse (or absent) for a moment. My own new best can only ever
        // improve my rank, so a worse reading here is stale by definition:
        // skip the write (a false "lost tier" event would notify now) and
        // let the deferred confirm below settle it.
        const lagging =
          prevGlobal != null &&
          prevGlobal <= 100 &&
          (e.globalRank == null || e.globalRank > prevGlobal);
        if (!lagging) applyGlobalCheck(e.beatmapId, e.globalRank, true, mode);
        // the leaderboard may not include the fresh score yet: confirm later
        scheduleGlobalConfirm(e.beatmapId, mode);
      } catch (err) {
        // failed check: back into the sweep queue, it will retry
        logError(err, `position check map ${e.beatmapId}`);
        db.prepare(
          `UPDATE beatmap_user SET global_checked_at = NULL WHERE beatmap_id = ? AND ruleset = ${mode}`
        ).run(e.beatmapId);
      }
    }
  }
  // UI feed first (independent of any webhook config), then Discord
  for (const e of bestEvents) pushBestFeed(e);
  notifyBests(bestEvents);
  if (newCount > 0) notifyMetricMilestones();
  if (newCount > 0) {
    // New plays move the profile figures (play count, play time, total
    // score, pp, medals). Drop the stored profile's freshness stamp (so a
    // failed refresh is retried by the next /auth/status hit) AND refresh
    // it right now in the background: by the time the UI learns about the
    // best (status poll, up to 5 s), the fresh numbers are already stored,
    // and the profile tiles count up in the SAME wave as the aggregates
    // instead of one minute behind them.
    try {
      const p = getStoredProfile(mode);
      if (p?.fetched_at) {
        delete p.fetched_at;
        setState(profileKey(mode), JSON.stringify(p));
      }
      if (isUserConnected()) void refreshStoredProfile(mode);
    } catch {
      /* cosmetic freshness only: never let it break the poll */
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

// API backoffs surfaced in the sync bar: during a Cloudflare block (error
// 1015) every request silently sits out 30 s+ penalties and the whole app
// looked dead — now it says so.
limiter.onBackoff = (ms, reason) => {
  // keep the throttled endpoint visible: an API-wide block and a rule on one
  // endpoint (oauth!) are different problems
  const short = reason.replace(/\s+/g, " ").slice(0, 90);
  status.message =
    `osu! API throttled (${short}): waiting ${Math.ceil(ms / 1000)} s, ` +
    `slowing to ~${limiter.effectiveRpm} req/min until it clears`;
  logActivity("api", status.message);
};

export function startPolling(): void {
  if (pollTimer) return;
  const tick = () => {
    // no credentials yet (first launch, UI settings not filled): stay quiet
    // instead of spamming an error every interval
    if (!config.hasCredentials) return;
    // NB: polling keeps running during the catalog import on purpose — new
    // scores must never be missed; it is high-priority and cheap.
    void pollRecentScores().catch((e) =>
      logError(e, "poll of recent scores (will retry on the next tick)")
    );
    // Self-healing sweeps: whenever tracking is on, the pass is idle and maps
    // are queued (requeues, backfill catch-up, failure stop…), resume without
    // waiting for the 6 h tick or a manual click. EXISTS check: ~free.
    const queued = (cond: string) =>
      getDb()
        .prepare(
          `SELECT 1 FROM beatmap_user u JOIN beatmaps b ON b.id = u.beatmap_id
           WHERE u.played = 1 AND ${cond}
             AND u.ruleset IN (${sqlIn(getStartedRulesets())})
             AND (b.ruleset = u.ruleset OR b.ruleset = 0) LIMIT 1`
        )
        .get() != null;
    const sweepsFree =
      !status.backfill.running && !catalogRunning && status.phase !== "catalog";
    if (
      sweepsFree &&
      isGlobalTrackingEnabled() &&
      !globalRunning &&
      queued("u.global_checked_at IS NULL")
    )
      void runGlobalSweep().catch((e) => logError(e, "global sweep"));
    if (
      sweepsFree &&
      isUserConnected() &&
      !countryRunning &&
      queued("u.country_checked_at IS NULL")
    )
      void runCountrySweep().catch((e) => logError(e, "country sweep"));
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

/** Modes whose enumeration is waiting for the running one (sync-bar visibility). */
const queuedEnumModes = new Set<number>();

/**
 * True while a catalog mode has not finished its enumeration. The seed catch-up
 * must not run then: every set it would look up individually (one request each)
 * is about to arrive from the search, 50 per page.
 */
function catalogIncomplete(): boolean {
  const cat = catalogRulesets();
  if (cat.length === 0) return true; // nothing started: nothing to catch up on
  if (cat.some((m) => m !== 0 && getState(`catalog_done_m${m}`) !== "1"))
    return true;
  if (!cat.includes(0)) return false;
  const std = (
    getDb()
      .prepare("SELECT COUNT(*) c FROM beatmaps WHERE ruleset = 0")
      .get() as { c: number }
  ).c;
  return std < MIN_EXPECTED_STD_DIFFS;
}

export async function ensureCatalogComplete(
  force = false,
  modes?: number[]
): Promise<number> {
  const db = getDb();
  let catalog = catalogRulesets();
  const rowsOf = (ms: number[]) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) c FROM beatmaps WHERE ruleset IN (${ms.join(",") || "-1"})`
        )
        .get() as { c: number }
    ).c;
  // Nothing enumerated for ANY catalog mode: leave that to the initial sync —
  // unless the caller named the modes it wants (a per-mode "Start initial
  // sync" IS the enumeration entry point on a fresh install).
  if (!modes?.length && rowsOf(catalog) === 0) return 0;
  // Another enumeration is running: a background call steps aside, an
  // explicit per-mode start WAITS for its turn (the rate limit is global, so
  // parallel runs would only interleave). Everything below is decided AFTER
  // the wait — the run we waited for has just changed the catalog.
  if (catalogRunning || status.phase === "catalog") {
    if (!modes?.length) return 0;
    // Shown in the busy list, NOT in status.message: the running import writes
    // there constantly and the two would fight. Without this the second mode
    // looked dead — its start button gone, nothing happening for an hour.
    for (const m of modes) queuedEnumModes.add(m);
    try {
      while (catalogRunning || status.phase === "catalog")
        await new Promise((r) => setTimeout(r, 5000));
    } finally {
      for (const m of modes) queuedEnumModes.delete(m);
    }
  }
  // The wait can last an hour: re-read what the catalog needs now. A mode
  // disabled in Settings while its import was queued simply drops out (its
  // catalog is no longer needed) instead of being enumerated anyway.
  catalog = catalogRulesets();
  if (modes?.length) {
    const dropped = modes.filter((m) => !catalog.includes(m));
    modes = modes.filter((m) => catalog.includes(m));
    if (dropped.length > 0)
      logActivity(
        "catalog",
        `${dropped.map(shortModeName).join(" + ")} disabled meanwhile, import cancelled`
      );
    if (modes.length === 0) return 0;
  }
  // std complete but a started mode's enumeration is unfinished: complete
  // ONLY that mode — never re-run the std slices as a side effect
  const unfinishedModes = catalog.filter(
    (m) => m !== 0 && getState(`catalog_done_m${m}`) !== "1"
  );
  // std must be complete whenever it is in the catalog — as a played mode or
  // as the convert source of another one
  const stdIncomplete =
    catalog.includes(0) && rowsOf([0]) < MIN_EXPECTED_STD_DIFFS;
  if (!force && !stdIncomplete) {
    if (unfinishedModes.length === 0 && !modes?.length) return 0;
    modes = modes ?? unfinishedModes;
  }
  // Starting a non-std mode also needs its CONVERT SOURCE: its pool counts the
  // std maps playable in it, so enumerating the mode alone leaves the pool with
  // its specifics only. Added only when std is actually behind — a complete std
  // catalog must not be re-scanned because someone started catch.
  if (modes?.length && stdIncomplete && !modes.includes(0))
    modes = [...modes, 0];

  catalogRunning = true;
  try {
    return await ensureCatalogCompleteInner(force, modes);
  } finally {
    catalogRunning = false;
  }
}

async function ensureCatalogCompleteInner(
  force: boolean,
  modes?: number[]
): Promise<number> {
  const before = poolCounts();
  // neutral wording: the expected size depends on which modes are started,
  // so no misleading "~150k expected" (std-era message)
  status.message = modes?.length
    ? `Enumerating the ${modes.map(shortModeName).join(" + ")} catalog via the API...`
    : "Completing the catalog via the API...";
  console.log(`[sync] ${status.message}`);
  // without force: resumes unfinished yearly slices (resumable);
  // with force: re-scans everything (also updates statuses + DMCA flags)
  await importCatalogFromApi((m) => {
    status.message = m;
    logActivity("catalog", m);
  }, { reset: force, modes });
  // No enrichment here: the known-sets catch-up runs right after and settles the
  // map count in a couple of minutes. Reading each map's details takes an hour,
  // and doing it first left the user staring at a count that was still wrong.
  const g = poolGrowth(before, poolCounts());
  console.log(`[sync] catalog completed: ${g.label}`);
  return g.total;
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

    const before = poolCounts();
    const newIds = await updateCatalogDelta((m) => {
      status.message = m;
      logActivity("new maps", m);
    });
    const added = poolGrowth(before, poolCounts()).label;
    status.lastDeltaNewMaps = newIds.length;
    if (newIds.length === 0) return 0;

    // up-to-date max_combo / SR for the new diffs (they have max_combo NULL)
    await enrichMaxCombo(enrichProgress);

    // targeted backfill: only the new diffs, for every started mode
    for (const id of newIds)
      await backfillMapAllModes(id, "low", `delta: backfill map ${id}`);
    logActivity("new maps", `${added} added`);
    console.log(`[sync] delta: ${added} added`);
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
        // automatic catch-up of the seed list (new app versions can ship a
        // bigger seed-sets.json: users get the new sets without any action)
        await importMissingKnownSets();
      }
      // then the gaps left by the search: max_combo, and the checksums added
      // for the collection export on databases enriched before that column.
      // Background: it can run for an hour and nothing else depends on it.
      // Never while the catalog is still being completed (repair, known-sets,
      // dump check) — that pass settles the map count and comes first.
      if (
        !enrichCatchupRunning &&
        !status.backfill.running &&
        !seedRunning &&
        maintenanceTasks.size === 0
      ) {
        enrichCatchupRunning = true;
        void enrichCatalog()
          .catch((e) => logError(e, "map details"))
          .finally(() => {
            enrichCatchupRunning = false;
          });
      }
      // snipe check: re-check my country #1s older than the configured delay
      if (isUserConnected()) {
        // maps with a fresh score still awaiting their country check: high
        // priority, ahead of the low-priority sweep
        await confirmRecentCountryChecks();
        getDb()
          .prepare(
            `UPDATE beatmap_user SET country_checked_at = NULL
             WHERE ruleset IN (${sqlIn(getStartedRulesets())}) AND country_first = 1
               AND country_checked_at < datetime('now', '-' || ? || ' hours')`
          )
          .run(getCountryRecheckHours());
        // Heal false snipes recorded before the empty-leaderboard guard: a
        // real snipe names the sniper, so a recent "lost" WITHOUT a sniper
        // is the degraded-fetch signature. Requeue those maps: the re-check
        // either restores the #1 (gained event) or confirms the loss with
        // its author. Window-bounded, so a genuine oddity cannot churn
        // forever.
        getDb().exec(
          `UPDATE beatmap_user SET country_checked_at = NULL
           WHERE ruleset IN (${sqlIn(getStartedRulesets())})
             AND country_first = 0 AND country_checked_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM country_events e
               WHERE e.beatmap_id = beatmap_user.beatmap_id
                 AND e.ruleset = beatmap_user.ruleset
                 AND e.event = 'lost' AND e.by_user_id IS NULL
                 AND e.at > datetime('now', '-7 days'))`
        );
        void runCountrySweep();
      }
      // global tops: re-check held top-100 positions older than the delay,
      // then resume the sweep (no-op when the queue is empty)
      if (isGlobalTrackingEnabled()) {
        const gdb = getDb();
        gdb
          .prepare(
            `UPDATE beatmap_user SET global_checked_at = NULL
             WHERE ruleset IN (${sqlIn(getStartedRulesets())})
               AND global_rank IS NOT NULL AND global_rank <= 100
               AND global_checked_at < datetime('now', '-' || ? || ' hours')`
          )
          .run(getGlobalRecheckHours());
        // Repair pass (mirrors the country one): a position stamped within
        // 15 min of one of my recent scores may predate the leaderboard
        // update — and the deferred-confirm timer does not survive a restart.
        gdb.exec(
          `UPDATE beatmap_user SET global_checked_at = NULL
           WHERE ruleset IN (${sqlIn(getStartedRulesets())})
             AND global_checked_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM scores s
             WHERE s.beatmap_id = beatmap_user.beatmap_id
               AND s.ruleset = beatmap_user.ruleset
               AND datetime(s.ended_at) >= datetime('now', '-2 days')
               AND datetime(beatmap_user.global_checked_at) <= datetime(s.ended_at, '+15 minutes'))`
        );
        // Heal false "outside top 100" drops recorded before the missing-
        // position guard: a rank that fell to NULL leaves the 48 h re-check
        // rotation (it only requeues ranks <= 100), so without this the
        // false state was permanent until a new score on the map. Requeue
        // every NULL rank with a recent drop-to-null event: the re-check
        // restores the real position (or stores the real one, a number,
        // which leaves this condition). Window-bounded.
        gdb.exec(
          `UPDATE beatmap_user SET global_checked_at = NULL
           WHERE ruleset IN (${sqlIn(getStartedRulesets())})
             AND global_rank IS NULL AND global_checked_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM global_events e
               WHERE e.beatmap_id = beatmap_user.beatmap_id
                 AND e.ruleset = beatmap_user.ruleset
                 AND e.new_rank IS NULL AND e.old_rank IS NOT NULL
                 AND e.at > datetime('now', '-7 days'))`
        );
        void runGlobalSweep();
      }
      // the maps those healing passes just requeued jump the queue: direct
      // high-priority re-check instead of waiting behind the whole backlog
      void confirmRepairedChecks().catch((e) => logError(e, "repair re-checks"));
      if (!status.backfill.running && !catalogRunning)
        void fillConvertAttrs().catch((e) => logError(e, "convert attrs"));
      // Self-heal: a STARTED mode whose initial enumeration never finished
      // (restart mid-import — remaining ranked years, the whole loved
      // category…) is resumed from its persisted slice cursors.
      const unfinished = getStartedRulesets().filter(
        (r) => r !== 0 && getState(`catalog_done_m${r}`) !== "1"
      );
      if (unfinished.length > 0 && !catalogRunning && !status.backfill.running)
        void ensureCatalogComplete(false, unfinished)
          .then(() => importMissingKnownSets())
          .then(() => enrichCatalog())
          .then(() => resumeBackfill())
          // without this catch a mid-chain failure was only a stderr line:
          // the sync bar read "idle" and the mode looked dead for 6 h
          .catch((e) => logError(e, "catalog self-heal"));
      // new official packs (no-op until the user imported the definitions)
      if (!packsDeltaRunning) {
        packsDeltaRunning = true;
        void import("./packs.js")
          .then((m) => m.refreshPacksDelta((msg) => logActivity("packs", msg)))
          .catch((e) => logError(e, "packs delta"))
          .finally(() => (packsDeltaRunning = false));
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
// Manual pause is sticky AND persistent (sync_state): automatic starts (poll
// auto-resume, 6 h tick, auth callback…) respect it across restarts; only a
// manual start (force) lifts it.
function isCountryPaused(): boolean {
  return getState("country_sweep_paused") === "1";
}

/**
 * Deferred confirmation after a new score: osu!'s leaderboard can take a
 * moment to include a fresh submit, so an immediate "not #1" result may be
 * stale. One re-check ~2 min later catches the propagation lag (without it,
 * the map would be stamped as checked and never revisited, since the periodic
 * snipe re-check only targets maps where country_first = 1).
 */
const COUNTRY_CONFIRM_DELAY_MS = 2 * 60_000;

function scheduleCountryConfirm(beatmapId: number, ruleset = 0): void {
  const t = setTimeout(() => {
    if (!isUserConnected()) return;
    getCountryTop(beatmapId, "high", rulesetDef(ruleset).apiName)
      .then((top) => applyCountryCheck(beatmapId, top, true, ruleset))
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
/**
 * HIGH-priority re-check of the maps the healing passes just requeued (a
 * global rank that fell to null, a country #1 "lost" to nobody): the sweeps
 * would eventually reach them, but BEHIND tens of thousands of pending
 * checks, hours away at the rate limit. A repair must land within the next
 * minute, not tomorrow. Capped per tick; the sweeps stay the safety net.
 */
export async function confirmRepairedChecks(): Promise<void> {
  const db = getDb();
  const modes = sqlIn(getStartedRulesets());
  if (config.hasCredentials) {
    const glo = db
      .prepare(
        `SELECT u.beatmap_id AS id, u.ruleset AS r FROM beatmap_user u
         WHERE u.ruleset IN (${modes}) AND u.global_checked_at IS NULL
           AND u.global_rank IS NULL AND u.global_seen = 1
           AND EXISTS (SELECT 1 FROM global_events e
                       WHERE e.beatmap_id = u.beatmap_id AND e.ruleset = u.ruleset
                         AND e.new_rank IS NULL AND e.old_rank IS NOT NULL
                         AND e.at > datetime('now', '-7 days'))
         LIMIT 50`
      )
      .all() as { id: number; r: number }[];
    for (const { id, r } of glo) {
      try {
        await lbSweepGate();
        const pos = await getUserBeatmapPosition(
          id,
          config.osuUserId,
          "high",
          rulesetDef(r).apiName
        );
        applyGlobalCheck(id, pos, true, r);
        logActivity(
          "global tops",
          () =>
            `${mapLabel(id)} · repair re-check: ${pos != null ? `#${pos}` : "outside top 100"}`
        );
      } catch (e) {
        logError(e, `repair global check map ${id}`);
      }
    }
  }
  if (!isUserConnected()) return;
  const cty = db
    .prepare(
      `SELECT u.beatmap_id AS id, u.ruleset AS r FROM beatmap_user u
       WHERE u.ruleset IN (${modes}) AND u.country_checked_at IS NULL
         AND u.country_first = 0
         AND EXISTS (SELECT 1 FROM country_events e
                     WHERE e.beatmap_id = u.beatmap_id AND e.ruleset = u.ruleset
                       AND e.event = 'lost' AND e.by_user_id IS NULL
                       AND e.at > datetime('now', '-7 days'))
       LIMIT 50`
    )
    .all() as { id: number; r: number }[];
  for (const { id, r } of cty) {
    try {
      await lbSweepGate();
      const top = await getCountryTop(id, "high", rulesetDef(r).apiName);
      applyCountryCheck(id, top, true, r);
      logActivity(
        "country #1",
        () =>
          `${mapLabel(id)} · repair re-check: ${
            top && top.user_id === config.osuUserId ? "#1 ✓" : "not #1"
          }`
      );
    } catch (e) {
      logError(e, `repair country check map ${id}`);
      if (isCountryAuthError(e)) break;
    }
  }
}

export async function confirmRecentCountryChecks(): Promise<void> {
  if (!isUserConnected()) return;
  const modes = sqlIn(getStartedRulesets()); // sqlIn: "IN ()" is a syntax error
  const rows = getDb()
    .prepare(
      `SELECT u.beatmap_id AS id, u.ruleset AS r FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE u.played = 1 AND u.country_checked_at IS NULL
         AND u.ruleset IN (${modes})
         AND (b.ruleset = u.ruleset OR b.ruleset = 0)
         AND EXISTS (
           SELECT 1 FROM scores s
           WHERE s.beatmap_id = u.beatmap_id AND s.ruleset = u.ruleset
             AND datetime(s.ended_at) >= datetime('now', '-2 days'))
       LIMIT 100`
    )
    .all() as { id: number; r: number }[];
  for (const { id, r } of rows) {
    try {
      await lbSweepGate(); // up to 100 maps: same endpoint budget as the sweeps
      const top = await getCountryTop(id, "high", rulesetDef(r).apiName);
      applyCountryCheck(id, top, true, r);
      logActivity(
        "country #1",
        () =>
          `${mapLabel(id)} · fresh-score recheck: ${
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
  recordInitial: boolean,
  ruleset = 0
): void {
  const db = getDb();
  const prev = db
    .prepare(
      "SELECT country_first, country_checked_at FROM beatmap_user WHERE beatmap_id = ? AND ruleset = ?"
    )
    .get(beatmapId, ruleset) as
    | { country_first: number; country_checked_at: string | null }
    | undefined;
  const isFirst = top && top.user_id === config.osuUserId ? 1 : 0;
  const wasChecked = prev?.country_checked_at != null;
  const prevFirst = prev?.country_first ?? 0;
  // A held #1 with an EMPTY leaderboard is never a real snipe: my own
  // eligible score was on that leaderboard, and a genuine snipe returns
  // the sniper's score on top, not nothing. An empty response is a
  // degraded fetch: keep the held state, requeue the map for a retry, and
  // record nothing (a false "lost" would now notify a phantom snipe).
  if (top == null && prevFirst === 1) {
    db.prepare(
      "UPDATE beatmap_user SET country_checked_at = NULL WHERE beatmap_id = ? AND ruleset = ?"
    ).run(beatmapId, ruleset);
    logActivity(
      "country #1",
      () => `${mapLabel(beatmapId)} · empty leaderboard on a held #1, retrying later`
    );
    return;
  }

  // Losing a held #1 is ALWAYS logged (country_first=1 implies a check had
  // established it, even if country_checked_at was reset to NULL for the re-check).
  // Gains stay silent during the initial sweep.
  const shouldRecord = prevFirst === 1 || wasChecked || recordInitial;
  if (shouldRecord && prevFirst !== isFirst) {
    db.prepare(
      `INSERT INTO country_events (beatmap_id, ruleset, event, at, score_at, by_user_id, by_username)
       VALUES (?, ?, ?, datetime('now'), ?, ?, ?)`
    ).run(
      beatmapId,
      ruleset,
      isFirst ? "gained" : "lost",
      // real date of the score that took the #1 (mine or the sniper's)
      top?.ended_at ?? null,
      isFirst ? null : top?.user_id ?? null,
      isFirst ? null : top?.user?.username ?? null
    );
    // Discord (opt-in per webhook): fires exactly when a "lost" event is
    // recorded, so it can never disagree with the history. The immediate
    // post-score check skips this function entirely on a lagging
    // leaderboard (see the poll), so false losses never get here.
    if (isFirst === 0) notifyCountryFirstLost(beatmapId, ruleset, top?.user?.username ?? null);
  }
  db.prepare(
    `UPDATE beatmap_user
       SET country_first = ?, country_checked_at = datetime('now'),
           country_seen_at = datetime('now')
     WHERE beatmap_id = ? AND ruleset = ?`
  ).run(isFirst, beatmapId, ruleset);
  // a recently notified best may have missed this honor (leaderboard lag):
  // let the Discord module edit the posted message. No-op when unwatched.
  updateBestHonors(beatmapId, ruleset);
}

/**
 * Checks the country leaderboard of each played, not-yet-checked map
 * (country_checked_at NULL) and marks country_first if I hold the top.
 * Resumable, low priority, requires a connected account (+supporter).
 */
export async function runCountrySweep(force = false): Promise<void> {
  if (countryRunning) return;
  if (isCountryPaused() && !force) return;
  if (force) setState("country_sweep_paused", "0");
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
    // One shared queue across the active rulesets (specific maps + converts).
    // Priority: 1. maps NEVER checked (the only ones that can still teach us
    // anything — without this rule the 48h re-check rotation starves them);
    // 2. held #1s, oldest first (snipe detection); 3. the rest, oldest first.
    // country_seen_at survives the re-queue, country_checked_at does not.
    const nextBatch = db.prepare(
      `SELECT u.beatmap_id AS id, u.ruleset AS r FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE u.played = 1 AND u.country_checked_at IS NULL
         AND u.ruleset IN (${sqlIn(getStartedRulesets())})
         AND (b.ruleset = u.ruleset OR b.ruleset = 0)
       ORDER BY u.country_seen_at IS NOT NULL,
                u.country_first DESC,
                u.country_seen_at,
                u.ruleset, u.beatmap_id
       LIMIT 200`
    );
    let done = 0;
    let firstBatch = true;
    while (countryWanted) {
      const rows = nextBatch.all() as { id: number; r: number }[];
      if (rows.length === 0) {
        // A manual start with an empty queue used to do nothing at all, with no
        // trace anywhere: the button just flipped back. Say so.
        if (firstBatch && force) {
          const cc = getStoredCountryCode();
          logActivity(
            `${cc ? `#1 ${cc}` : "country #1"} sweep`,
            "nothing to do, every played map is already checked"
          );
        }
        break;
      }
      firstBatch = false;
      for (const { id, r } of rows) {
        if (!countryWanted) break;
        try {
          await lbSweepGate();
          const top = await getCountryTop(id, "low", rulesetDef(r).apiName);
          const cc = getStoredCountryCode();
          applyCountryCheck(id, top, false, r);
          done++;
          logActivity(
              `${cc ? `#1 ${cc}` : "country #1"} sweep`,
            () =>
              `${mapLabel(id)} · ${
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
  setState("country_sweep_paused", "1");
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
  recordInitial = false,
  ruleset = 0
): void {
  const db = getDb();
  const prev = db
    .prepare(
      "SELECT global_rank, global_checked_at, global_seen FROM beatmap_user WHERE beatmap_id = ? AND ruleset = ?"
    )
    .get(beatmapId, ruleset) as
    | {
        global_rank: number | null;
        global_checked_at: string | null;
        global_seen: number;
      }
    | undefined;
  const prevRank = prev?.global_rank ?? null;
  // Belt matching the API-side guard: the position endpoint reports the
  // ABSOLUTE rank, so a real drop below 100 arrives as a number (#4523),
  // never as null. A null landing on a map with a KNOWN rank means the
  // check could not see the leaderboard (or the score vanished, which is
  // extraordinary): keep the known state and requeue instead of recording
  // a false "outside top 100".
  if (pos == null && prevRank != null) {
    db.prepare(
      "UPDATE beatmap_user SET global_checked_at = NULL WHERE beatmap_id = ? AND ruleset = ?"
    ).run(beatmapId, ruleset);
    logActivity(
      "global tops",
      () => `${mapLabel(beatmapId)} · no position on a ranked map (held #${prevRank}), retrying later`
    );
    return;
  }
  // "known" = a previous check happened — global_seen survives the re-queues
  // that reset global_checked_at, so re-check transitions are always logged
  const wasKnown =
    prevRank != null || prev?.global_checked_at != null || prev?.global_seen === 1;
  const oldTier = globalTier(prevRank);
  const newTier = globalTier(pos);
  if ((wasKnown || recordInitial) && oldTier !== newTier) {
    db.prepare(
      "INSERT INTO global_events (beatmap_id, ruleset, at, old_rank, new_rank) VALUES (?, ?, datetime('now'), ?, ?)"
    ).run(beatmapId, ruleset, prevRank, pos);
    logActivity(
      "global tops",
      () =>
        `${mapLabel(beatmapId)} · ${oldTier ? `top ${oldTier}` : "outside top 100"} → ${
          newTier ? `top ${newTier}` : "outside top 100"
        } (${prevRank != null ? `#${prevRank}` : "—"} → ${pos != null ? `#${pos}` : "—"}) (global)`
    );
    // Discord (opt-in per webhook): only downward tier moves; the notifier
    // re-derives the tiers and ignores gains by itself
    if (oldTier != null && (newTier == null || newTier > oldTier))
      notifyGlobalTopLost(beatmapId, ruleset, prevRank, pos);
  }
  db.prepare(
    "UPDATE beatmap_user SET global_rank = ?, global_checked_at = datetime('now'), global_seen = 1 WHERE beatmap_id = ? AND ruleset = ?"
  ).run(pos, beatmapId, ruleset);
  // same late-honors hook as the country check (see applyCountryCheck)
  updateBestHonors(beatmapId, ruleset);
}

/**
 * Deferred confirmation after a new best: like the country leaderboard, the
 * global one can lag behind a fresh submit — the immediate check may return
 * the OLD position (or none) and, when it lands outside the top 100, nothing
 * would ever re-check it. One re-check a few minutes later catches it.
 */
const GLOBAL_CONFIRM_DELAY_MS = 3 * 60_000;

function scheduleGlobalConfirm(beatmapId: number, ruleset = 0): void {
  const t = setTimeout(() => {
    if (!config.hasCredentials) return;
    getUserBeatmapPosition(
      beatmapId,
      config.osuUserId,
      "high",
      rulesetDef(ruleset).apiName
    )
      .then((pos) => applyGlobalCheck(beatmapId, pos, true, ruleset))
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
    // shared queue across active rulesets (specific + converts); held ranks
    // first (losing a top spot matters more than discovering a new #4000)
    const nextBatch = db.prepare(
      `SELECT u.beatmap_id AS id, u.ruleset AS r FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE u.played = 1 AND u.global_checked_at IS NULL
         AND u.ruleset IN (${sqlIn(getStartedRulesets())})
         AND (b.ruleset = u.ruleset OR b.ruleset = 0)
       ORDER BY (u.global_rank IS NOT NULL) DESC, u.global_rank, u.ruleset, u.beatmap_id
       LIMIT 200`
    );
    let done = 0;
    let failures = 0;
    let firstBatch = true;
    while (globalWanted) {
      const rows = nextBatch.all() as { id: number; r: number }[];
      if (rows.length === 0) {
        if (firstBatch && force)
          logActivity("global tops sweep", "nothing to do, every played map is already checked");
        break;
      }
      firstBatch = false;
      for (const { id, r } of rows) {
        if (!globalWanted) break;
        try {
          await lbSweepGate();
          const pos = await getUserBeatmapPosition(
            id,
            config.osuUserId,
            "low",
            rulesetDef(r).apiName
          );
          applyGlobalCheck(id, pos, false, r);
          done++;
          failures = 0;
          logActivity(
            "global tops sweep",
            () => `${mapLabel(id)} · ${pos != null ? `#${pos}` : "not on leaderboard"} (global)`
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
 * ranked/approved/loved set of a complete reference catalog — including the
 * DMCA/delisted ones /beatmapsets/search never returns — as
 * `{ "<set id>": <ruleset bitmask> }` (1 osu!, 2 taiko, 4 catch, 8 mania).
 * A set is fetched by direct lookup (API then web page) when the seed says it
 * carries diffs for a mode we track and we hold none of that mode: no budget
 * spent on rulesets the user never started, and a hybrid set missing ONE mode's
 * diffs is caught too (the plain "no diff at all" test misses those).
 * Runs after the search enumeration is done; no-op once the catalog is complete.
 */
let seedRunning = false;

/**
 * Reads the shipped seed list. Three shapes, oldest first (see SeedVersion):
 * flat ids, per-mode bitmask, per-mode diff COUNTS — only the last one can spot
 * a set holding some of a mode's diffs but not all of them.
 */
function readSeed(): { version: SeedVersion; entries: [number, number][] } | null {
  const seedPath = path.join(__dirname, "../db/seed-sets.json");
  if (!fs.existsSync(seedPath)) return null;
  const raw = JSON.parse(fs.readFileSync(seedPath, "utf8")) as
    | number[]
    | Record<string, number>
    | { v: number; sets: Record<string, number> };
  if (Array.isArray(raw))
    return { version: 0, entries: raw.map((id) => [id, 0]) };
  if (typeof (raw as { v?: number }).v === "number")
    return {
      version: 2,
      entries: Object.entries((raw as { sets: Record<string, number> }).sets).map(
        ([id, v]) => [Number(id), v]
      ),
    };
  return {
    version: 1,
    entries: Object.entries(raw as Record<string, number>).map(([id, m]) => [
      Number(id),
      m,
    ]),
  };
}

export async function importMissingKnownSets(): Promise<number> {
  if (seedRunning) return 0;
  if (catalogIncomplete()) {
    // said in the feed too: silence here reads as "the seed list is not used"
    logActivity(
      "catalog",
      "known-sets list postponed, the catalog import is not done yet"
    );
    console.log(
      "[sync] known-sets catch-up postponed: a catalog enumeration is unfinished (looking these sets up one by one would waste hours)"
    );
    return 0;
  }
  seedRunning = true;
  try {
    const seed = readSeed();
    if (!seed) return 0;
    const { version, entries } = seed;
    const db = getDb();
    // std counts too when it only feeds another mode's converts
    const tracked = catalogRulesets();

    // local diff counts per set and per ruleset
    const localCounts = new Map<number, number[]>();
    for (const r of db
      .prepare(
        `SELECT beatmapset_id AS id, ruleset, COUNT(*) n FROM beatmaps
         WHERE status IN (1, 2, 4) GROUP BY beatmapset_id, ruleset`
      )
      .all() as { id: number; ruleset: number; n: number }[]) {
      const arr = localCounts.get(r.id) ?? [0, 0, 0, 0];
      arr[r.ruleset] = r.n;
      localCounts.set(r.id, arr);
    }
    const FORMAT_NOTE: Record<SeedVersion, string> = {
      0: " (old format: ids only, regenerate it to catch per-mode holes)",
      1: " (old format: no diff counts, regenerate it to catch partial sets)",
      2: "",
    };
    // No "looked up recently" filter: a stale `checked_at` can hide a set
    // whose diffs of a newly started mode are still missing. Re-looking up a
    // handful of stubborn sets per repair is cheaper than the confusion.
    const missing = entries
      .filter(([id, value]) => {
        const have = localCounts.get(id) ?? [0, 0, 0, 0];
        // a flat-id seed knows nothing per mode: only a set with no diff at all
        if (version === 0) return have.every((n) => n === 0);
        return seedNeedsLookup(seedCounts(value, version), have, tracked);
      })
      .map(([id]) => id);
    if (missing.length === 0) {
      // Silence used to look like "the shipped list is never used": say that it
      // WAS checked and matched, and in which format.
      logActivity(
        "catalog",
        `known-sets list checked, ${entries.length} sets, nothing missing${FORMAT_NOTE[version]}`
      );
      return 0;
    }

    logActivity(
      "catalog",
      `known-sets list: ${missing.length} set(s) to fetch, the search cannot see them`
    );
    console.log(`[sync] known-sets catch-up: ${missing.length} sets missing`);
    const before = poolCounts();
    let failures = 0;
    for (const id of missing) {
      try {
        const r = await importSetById(id);
        failures = 0;
        logActivity(
          "catalog",
          `known-sets catch-up: set ${id} (${r.source ?? "not found"}, ${r.added})`
        );
        status.message = `known-sets catch-up: ${poolGrowth(before, poolCounts()).label}...`;
      } catch (e) {
        logError(e, `known-sets catch-up: set ${id}`);
        if (++failures >= 10) break; // API down / auth issue: retry next tick
      }
    }
    const g = poolGrowth(before, poolCounts());
    // No enrichment here: every caller runs enrichCatalog() right after, and
    // enriching under this label kept "known-sets import" in the sync bar for
    // the whole hour it takes.
    if (g.total > 0) status.message = `known-sets catch-up done: ${g.label}.`;
    return g.total;
  } finally {
    seedRunning = false;
  }
}

/** Manual import of a set (API then web page) + backfill of its diffs. */
export async function importSetById(
  setId: number,
  opts: { backfillInBackground?: boolean } = {}
): Promise<{ source: "api" | "web" | null; added: string }> {
  const before = poolCounts();
  const { source, newIds } = await importOneSet(setId);
  // measured before the (rate-limited, minutes-long) backfill, so a concurrent
  // delta import cannot inflate what THIS set added
  const added = poolGrowth(before, poolCounts()).label;
  const backfill = async () => {
    for (const id of newIds)
      await backfillMapAllModes(id, "high", `import set ${setId}: backfill map ${id}`);
  };
  // Manual imports answer NOW: on a big new set the backfill takes minutes at
  // the rate limit, and the UI looked frozen while its request waited for it.
  // backfillMap logs and swallows per-map errors, so nothing is lost.
  if (opts.backfillInBackground)
    void backfill().catch((e) => console.error(`[sync] import set ${setId}:`, e));
  else await backfill();
  return { source, added };
}

/**
 * Manual re-fetch of MY scores on every already-fetched diff of a set, all
 * started rulesets. The recent-scores endpoint only covers 24 h, so plays made
 * while the app was off are invisible to polling — this recovers what the
 * per-map endpoint exposes (the best score per mod combination; other offline
 * plays are not retrievable, except one by one via their score id).
 */
export async function refetchSetScores(setId: number): Promise<number> {
  const rows = getDb()
    .prepare(
      `SELECT u.beatmap_id AS id, u.ruleset AS r FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       WHERE b.beatmapset_id = ? AND u.fetched_at IS NOT NULL`
    )
    .all(setId) as { id: number; r: number }[];
  for (const { id, r } of rows)
    await backfillMap(id, "high", `re-fetch set ${setId}: map ${id}`, r);
  if (rows.length > 0)
    logActivity("import", `set ${setId}: ${rows.length} diff(s) re-checked for scores`);
  return rows.length;
}

/** Targeted year verification (search vs local DB) + backfill. */
export async function verifyYearAndBackfill(year: number) {
  const before = poolCounts();
  const result = await verifyYear(year, (m) => (status.message = m));
  const added = poolGrowth(before, poolCounts()).label;
  if (result.newBeatmapIds.length > 0) {
    await enrichMaxCombo(enrichProgress);
    for (const id of result.newBeatmapIds)
      await backfillMapAllModes(id, "low", `verify-year: backfill map ${id}`);
  }
  status.message = `verify ${year} done: ${added}.`;
  return result;
}

/** Manual repair of mega-collabs (>100 diffs) + backfill of the new ones. */
// Busy labels for the sync bar during manual maintenance. A Set, not one
// slot: two overlapping actions must not clear each other's label.
const maintenanceTasks = new Set<string>();
let packsDeltaRunning = false;
// Current pass ("score import (catch converts)", …) for the busy list.
let backfillPassLabel = "score import";
let backfillPassRuleset: number | null = null;

/** Opt-in import of the official pack definitions, with sync-bar visibility. */
export async function runPacksImport(): Promise<number> {
  const { importPacks } = await import("./packs.js");
  maintenanceTasks.add("packs import");
  try {
    const n = await importPacks((m) => {
      status.message = m;
      logActivity("packs", m);
    });
    if (n == null) {
      logActivity("packs", "import already running");
      return 0;
    }
    return n;
  } finally {
    maintenanceTasks.delete("packs import");
  }
}

/** Catalog verification vs a data.ppy.sh dump file, with sync-bar visibility. */
export async function runDumpVerify(path: string, modes?: number[]): Promise<string> {
  const { verifyCatalogFromDump } = await import("./dump.js");
  maintenanceTasks.add("dump verification");
  try {
    const g = await verifyCatalogFromDump(
      path,
      modes?.length ? modes : catalogRulesets(),
      (m) => {
        status.message = `dump: ${m}`;
        logActivity("dump", m);
      },
      // heartbeat: visible freshness without flooding the activity feed
      (m) => (status.message = `dump: ${m}`)
    );
    if (g == null) {
      logActivity("dump", "verification already running");
      return "already running";
    }
    // background, like the repair: both have their own label and hours of
    // work, awaiting them kept "dump verification" on screen the whole time
    if (g.total > 0)
      void enrichCatalog()
        .then(() => resumeBackfill())
        .catch((e) => logError(e, "after dump"));
    return g.label;
  } catch (e) {
    logActivity("dump", `failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    maintenanceTasks.delete("dump verification");
  }
}

/**
 * One-click catalog repair: re-lookup of the known DMCA sets, then repair of
 * the truncated mega-collabs, then enrichment + backfill of anything new.
 * The data-dump verification (runDumpVerify) stays separate: it needs a file
 * and only matters when the map counts still look wrong after this.
 */
export async function runCatalogRepair(): Promise<string> {
  const prog = (m: string) => (status.message = `repair: ${m}`);
  // A repair only makes sense on an enumerated catalog (its whole job is the
  // holes the search cannot see), so wait out any running enumeration —
  // BEFORE claiming the busy label and the pool snapshot, which would
  // otherwise count the enumeration's maps as the repair's own.
  while (catalogRunning || status.phase === "catalog") {
    status.message = "repair: waiting for the catalog enumeration to finish…";
    await new Promise((r) => setTimeout(r, 5000));
  }
  maintenanceTasks.add("catalog repair");
  const before = poolCounts();
  try {
    // 1. known-sets seed catch-up (sets the search enumeration cannot see)
    await importMissingKnownSets();
    // 2. re-lookup of the known DMCA sets — only useful with an OLD seed: a
    // v2 seed carries per-mode diff counts for EVERY set, so the catch-up
    // above already covers this population.
    if (readSeed()?.version === 2)
      logActivity(
        "repair",
        "delisted re-check skipped, the known-sets list already covers those sets"
      );
    else
      await recheckDelistedSets((m) => {
        prog(m);
        logActivity("repair", m);
      });
    await repairOversizedSets(prog);
    const g = poolGrowth(before, poolCounts());
    // NOT awaited (and outside the label): map details then the score import
    // both run for a long time under their own label. Waiting for them kept
    // "catalog repair" on screen all that time.
    if (g.total > 0)
      void enrichCatalog()
        .then(() => resumeBackfill())
        .catch((e) => logError(e, "after repair"));
    logActivity("repair", `catalog repair done: ${g.label}`);
    return g.label;
  } finally {
    maintenanceTasks.delete("catalog repair");
  }
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
          "Catalog import already running in the background, waiting for it...";
        await new Promise((r) => setTimeout(r, 5000));
      }
      catalogRunning = true;
      try {
        status.message = "Importing beatmap catalog from the osu! API...";
        await importCatalogFromApi((m) => {
          status.message = m;
          logActivity("catalog", m);
        });
        // Automatic completeness — no fix button needed: the DMCA/delisted
        // sets invisible to the search (bundled seed list), then the sets
        // truncated by the ~100-diff payload cap (web page re-fetch).
        status.message = "Completing the catalog (known delisted sets)…";
        await importMissingKnownSets();
        await repairOversizedSets((m) => (status.message = m));
      } finally {
        catalogRunning = false;
      }
    }

    status.message = "Reading map details (max combo, checksum)...";
    await enrichCatalog();

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
  status.message = "Score backfill in progress (resumable)...";
  try {
    // Queue order: std first, then each active ruleset's SPECIFIC maps, then
    // the CONVERTS of each active ruleset (std maps played in that mode) —
    // the cheap high-value passes go before the huge convert grind. Each pass
    // is resumable independently (fetched_at NULL per (map, ruleset) row).
    const passes: { ruleset: number; mapMode: number; label: string }[] = [];
    for (const r of getStartedRulesets())
      passes.push({
        ruleset: r,
        mapMode: r,
        label: r === 0 ? "score import" : `score import (${shortModeName(r)})`,
      });
    for (const r of getStartedRulesets())
      if (r !== 0)
        passes.push({
          ruleset: r,
          mapMode: 0,
          label: `score import (${shortModeName(r)} converts)`,
        });

    let completed = false;
    const skippedPaused = new Set<string>();
    outer: for (const pass of passes) {
      if (isBackfillModePaused(pass.ruleset)) {
        skippedPaused.add(shortModeName(pass.ruleset));
        continue; // paused mode: skip
      }
      backfillPassLabel =
        pass.label === "score import" ? "score import (osu!)" : pass.label;
      backfillPassRuleset = pass.ruleset;
      const nextBatch = db.prepare(
        `SELECT b.id FROM beatmaps b
         LEFT JOIN beatmap_user u ON u.beatmap_id = b.id AND u.ruleset = ${pass.ruleset}
         WHERE b.ruleset = ${pass.mapMode} AND u.fetched_at IS NULL
         ORDER BY b.id
         LIMIT 200`
      );
      for (;;) {
        if (!backfillWanted) break outer;
        if (isBackfillModePaused(pass.ruleset)) continue outer; // paused mid-pass
        const ids = (nextBatch.all() as { id: number }[]).map((r) => r.id);
        if (ids.length === 0) break; // pass done, next one
        for (const id of ids) {
          if (!backfillWanted) break outer;
          if (isBackfillModePaused(pass.ruleset)) continue outer;
          const scores = await backfillMap(
            id,
            "low",
            `${pass.label} map ${id}`,
            pass.ruleset
          );
          if (scores)
            logActivity(
              pass.label,
              () =>
                `${mapLabel(id)}${scores.length ? ` · ${scores.length} score(s)` : ""}`
            );
        }
      }
    }
    completed = backfillWanted; // reached the end of every pass without a pause
    // Paused modes were skipped: say it loudly, otherwise "the backfill does
    // nothing" with no clue why (the flag survives restarts on purpose)
    if (skippedPaused.size > 0)
      logActivity(
        "scores",
        `${[...skippedPaused].join(" + ")} paused, resume it from that mode's tab`
      );
    // Backfill done => run the leaderboard passes that were deferred while it
    // held the rate budget: country sweep first (needs the connected
    // account), then the global tops sweep. Initial sync therefore chains
    // catalog -> scores -> country -> global tops.
    if (completed) {
      status.backfill.running = false;
      void (async () => {
        if (isUserConnected()) await runCountrySweep();
        if (isGlobalTrackingEnabled()) await runGlobalSweep();
        await fillConvertAttrs();
      })().catch((e) => logError(e, "post-backfill sweeps"));
    }
  } finally {
    status.backfill.running = false;
  }
}

/**
 * Recomputes the bests (and best_fc/played flags) of every map with scores —
 * catch-up after a logic change or scores imported by an older server version.
 */
export function recomputeAllBests(): number {
  const db = getDb();
  // per (map, ruleset): the ruleset-0 default silently skipped every
  // taiko/catch/mania best and created bogus ruleset-0 rows for their maps
  const ids = db
    .prepare("SELECT DISTINCT beatmap_id AS id, ruleset AS r FROM scores")
    .all() as { id: number; r: number }[];
  // markFetched: false => we preserve each map's backfill state
  for (const { id, r } of ids) refreshBest(id, false, r);
  bumpScoresVersion(); // bests changed without a score write: invalidate caches
  return ids.length;
}
