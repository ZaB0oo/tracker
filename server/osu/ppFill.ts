import { getDb } from "../db/db.js";
import type { ModRef } from "../logic/score.js";
import { hasOsuFile, localPp, perfHits } from "./difficulty.js";

/**
 * Background fill of `scores.pp_local`: every passed score the API left at
 * pp NULL (unranked mod combos) gets a locally computed value, newest first —
 * what the dashboard shows first is filled first. One score at a time, paced
 * so the map downloads stay a slow background trickle (a full catalog of
 * missing files takes hours, and that is fine). Ranked and approved maps
 * only: the game never grants pp on loved maps, and their aspire outliers
 * produced six-figure estimates that drowned every pp total.
 *
 * -1 is stored when a value can never exist: automation mods (relax plays
 * earn no pp, and an aim-assisted estimate would be meaningless) or a map
 * rosu cannot read. A failed DOWNLOAD stores nothing and is retried on a
 * later cycle.
 */
const AUTOMATION = new Set(["RX", "AP", "AT", "CN"]);
const BATCH = 100;
const IDLE_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bumped as values land so the caches built on pp (records totals, scatter,
// sessions, pp metrics) pick fresh fills up — but only every BUMP_EVERY
// stores and at the end of a pass, so a running backfill does not force the
// heavy aggregates to recompute on every request.
const BUMP_EVERY = 200;
let stores = 0;
let version = 0;
export function ppLocalVersion(): number {
  return version;
}
function stored(): void {
  if (++stores % BUMP_EVERY === 0) version++;
}

let running = false;

export function startPpBackfill(): void {
  if (running) return;
  running = true;
  void loop();
}

/**
 * Targeted fill for a score the user is LOOKING at (map modal): the backfill
 * walks newest-first and would reach an old score much later. Fire-and-forget;
 * the 60s refetch (or reopening the modal) picks the value up.
 */
const inFlight = new Set<number>();
export function queueLocalPp(s: Row): void {
  if (inFlight.has(s.id)) return;
  inFlight.add(s.id);
  void (async () => {
    try {
      let mods: ModRef[] = [];
      try {
        mods = (JSON.parse(s.mods) as ModRef[]) ?? [];
      } catch {
        // unreadable mods: treated as nomod
      }
      const db = getDb();
      if (
        mods.some((m) => AUTOMATION.has(m?.acronym)) ||
        perfHits(s.ruleset, s.statistics) == null
      ) {
        db.prepare("UPDATE scores SET pp_local = -1 WHERE id = ?").run(s.id);
        return;
      }
      const had = hasOsuFile(s.mapId);
      const pp = await localPp(s.mapId, mods, s.ruleset, s);
      if (pp != null) {
        db.prepare("UPDATE scores SET pp_local = ? WHERE id = ?").run(pp, s.id);
        version++; // targeted fill: the user is looking at it
      } else if (had) {
        db.prepare("UPDATE scores SET pp_local = -1 WHERE id = ?").run(s.id);
      }
    } finally {
      inFlight.delete(s.id);
    }
  })();
}

export interface Row {
  id: number;
  mapId: number;
  ruleset: number;
  mods: string;
  statistics: string;
  accuracy: number;
  maxCombo: number;
}

async function loop(): Promise<void> {
  const db = getDb();
  const next = db.prepare(
    `SELECT s.id, s.beatmap_id AS mapId, s.ruleset, s.mods, s.statistics,
       s.accuracy, s.max_combo AS maxCombo
     FROM scores s
     JOIN beatmaps b ON b.id = s.beatmap_id
     WHERE s.pp IS NULL AND s.pp_local IS NULL AND s.passed = 1
       AND b.status IN (1, 2)
     ORDER BY s.ended_at DESC LIMIT ${BATCH}`
  );
  const store = db.prepare("UPDATE scores SET pp_local = ? WHERE id = ?");
  // maps whose download failed this cycle: skipped until the next idle wait,
  // otherwise the same broken download would be retried in a tight loop
  let failed = new Set<number>();
  let done = 0;
  for (;;) {
    const rows = (next.all() as unknown as Row[]).filter((r) => !failed.has(r.mapId));
    if (rows.length === 0) {
      if (done > 0) {
        console.log(`[pp] backfill pass done: ${done} scores filled`);
        version++;
      }
      done = 0;
      failed = new Set();
      await sleep(IDLE_MS);
      continue;
    }
    for (const s of rows) {
      let mods: ModRef[] = [];
      try {
        mods = (JSON.parse(s.mods) as ModRef[]) ?? [];
      } catch {
        // unreadable mods: treated as nomod
      }
      // no hit counts, no estimate (see localPp): permanent, like automation
      if (
        mods.some((m) => AUTOMATION.has(m?.acronym)) ||
        perfHits(s.ruleset, s.statistics) == null
      ) {
        store.run(-1, s.id);
        continue;
      }
      const had = hasOsuFile(s.mapId);
      const pp = await localPp(s.mapId, mods, s.ruleset, s);
      if (pp != null) {
        store.run(pp, s.id);
        done++;
        stored();
      } else if (had || hasOsuFile(s.mapId)) {
        // the file is there and still no value: permanent, stop retrying
        store.run(-1, s.id);
      } else {
        failed.add(s.mapId);
      }
      await sleep(had ? 100 : 700);
    }
  }
}
