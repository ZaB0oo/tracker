import { getDb } from "../db/db.js";
import { srMods, srModsKey } from "../logic/score.js";
import { hasOsuFile, localStarRating } from "./difficulty.js";

/**
 * Background fill of the modded-SR cache (`modded_sr`): every BEST played
 * with difficulty mods gets its true star rating computed locally, oldest
 * map first. Without this pass the cache only grew when a row was LOOKED AT
 * (a table page, a metric list, a Discord embed), tens of thousands of
 * modded bests never displayed anywhere stayed uncomputed forever.
 *
 * Same shape as the pp backfill next door: one slow loop, paced so the .osu
 * downloads stay a background trickle (most files are already on disk from
 * the pp pass, those compute in milliseconds). A null rating with the file
 * present is PERMANENT (suspicious/unreadable map) and stored as null so it
 * is never retried; a failed download stores nothing and is retried on a
 * later cycle.
 */
const BATCH = 200;
const IDLE_MS = 60 * 60_000; // full rescan is ~100k cache lookups: hourly is plenty

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = false;

export function startSrBackfill(): void {
  if (running) return;
  running = true;
  void loop();
}

interface Row {
  mapId: number;
  ruleset: number;
  mods: string;
}

async function loop(): Promise<void> {
  const db = getDb();
  // keyset cursor over (beatmap_id, ruleset): the key itself cannot be
  // computed in SQL, so every modded best is walked and the cache decides
  const next = db.prepare(
    `SELECT u.beatmap_id AS mapId, u.ruleset, s.mods
     FROM beatmap_user u
     JOIN scores s ON s.id = u.best_lazer_score_id
     WHERE u.played = 1 AND s.mods != '[]'
       AND (u.beatmap_id > ? OR (u.beatmap_id = ? AND u.ruleset > ?))
     ORDER BY u.beatmap_id, u.ruleset LIMIT ${BATCH}`
  );
  const cached = db.prepare(
    "SELECT 1 FROM modded_sr WHERE beatmap_id = ? AND ruleset = ? AND mods = ?"
  );
  const store = db.prepare(
    "INSERT OR REPLACE INTO modded_sr (beatmap_id, ruleset, mods, star_rating) VALUES (?, ?, ?, ?)"
  );
  // maps whose download failed this cycle: skipped until the next idle wait,
  // otherwise the same broken download would be retried in a tight loop
  let failed = new Set<number>();
  let curMap = 0;
  let curMode = -1;
  let done = 0;
  for (;;) {
    const rows = next.all(curMap, curMap, curMode) as unknown as Row[];
    if (rows.length === 0) {
      if (done > 0) console.log(`[sr] modded-SR backfill pass done: ${done} filled`);
      done = 0;
      failed = new Set();
      curMap = 0;
      curMode = -1;
      await sleep(IDLE_MS);
      continue;
    }
    for (const r of rows) {
      curMap = r.mapId;
      curMode = r.ruleset;
      const mods = srMods(r.mods);
      if (mods.length === 0) continue; // score-only mods (NF, SD…): no entry needed
      const key = srModsKey(mods);
      if (cached.get(r.mapId, r.ruleset, key) !== undefined) continue;
      if (failed.has(r.mapId)) continue;
      const had = hasOsuFile(r.mapId);
      const sr = await localStarRating(r.mapId, mods, r.ruleset);
      if (sr == null && !hasOsuFile(r.mapId)) {
        failed.add(r.mapId); // transient: the download failed, retry next cycle
        await sleep(700);
        continue;
      }
      store.run(r.mapId, r.ruleset, key, sr);
      done++;
      await sleep(had ? 150 : 700);
    }
    // a fully-cached batch has no await at all: without this yield a rescan
    // over ~100k cached bests would block the event loop for seconds
    await sleep(50);
  }
}
