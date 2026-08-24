import fs from "node:fs";
import path from "node:path";
import { Beatmap, Difficulty, GameMode, Performance } from "rosu-pp-js";
import { config } from "../config.js";
import { computeRate, type ModRef } from "../logic/score.js";

/**
 * Star rating for the exact mods that were played, computed here.
 *
 * The API cannot answer this. `POST /beatmaps/{id}/attributes` forwards the
 * mods to ppy's difficulty cache, which turns them into a legacy bitset before
 * looking the value up: DT at any rate collapses to the DoubleTime bit, so a
 * 1.2x play gets the 1.5x rating back and every mod setting is dropped. lazer
 * itself computes the rating from the `.osu` file, and so do we.
 *
 * The files are kept next to the database. A ranked map's `.osu` never changes,
 * so one download per map is enough, and only the maps we actually display a
 * rating for are ever fetched.
 */

const filesDir = path.join(path.dirname(config.dbPath), "beatmaps");

/** One download at a time: this is a plain file endpoint, not the API. */
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function cached(beatmapId: number): Buffer | null {
  try {
    return fs.readFileSync(path.join(filesDir, `${beatmapId}.osu`));
  } catch {
    return null;
  }
}

/** Is the .osu already on disk? Separates permanent failures (file present,
 * map suspicious/unreadable) from transient ones (download failed). */
export function hasOsuFile(beatmapId: number): boolean {
  return fs.existsSync(path.join(filesDir, `${beatmapId}.osu`));
}

async function osuFile(beatmapId: number): Promise<Buffer | null> {
  const hit = cached(beatmapId);
  if (hit) return hit;
  return serialise(async () => {
    // a concurrent caller may have downloaded it while we waited
    const late = cached(beatmapId);
    if (late) return late;
    try {
      const res = await fetch(`https://osu.ppy.sh/osu/${beatmapId}`, {
        headers: { "User-Agent": config.userAgent },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0) throw new Error("empty file");
      fs.mkdirSync(filesDir, { recursive: true });
      const file = path.join(filesDir, `${beatmapId}.osu`);
      const part = `${file}.part`;
      fs.writeFileSync(part, body);
      fs.renameSync(part, file);
      return body;
    } catch (e) {
      console.error(`[difficulty] map ${beatmapId} not downloaded:`, e);
      return null;
    }
  });
}

/**
 * Star rating of a map under `mods`, settings included, for one ruleset.
 * Returns null when the map cannot be read or converted: the caller falls back
 * to the map's own rating rather than showing a wrong one.
 */
export async function localStarRating(
  beatmapId: number,
  mods: ModRef[],
  rulesetId = 0
): Promise<number | null> {
  const content = await osuFile(beatmapId);
  if (!content) return null;
  let map: Beatmap | null = null;
  try {
    map = new Beatmap(content);
    if ((map.mode as number) !== rulesetId) map.convert(rulesetId as GameMode, mods);
    // maps built to break the calculator rather than to be played
    if (map.isSuspicious()) return null;
    // rosu applies the fixed-rate mods itself but silently IGNORES the ramps
    // (WU/WD/AS): the rate is computed like scores.rate and passed explicitly.
    // For DT/HT it resolves to the same speed_change rosu would use, so the
    // override never disagrees.
    const clockRate = computeRate(mods as Parameters<typeof computeRate>[0]);
    const stars = new Difficulty({
      mods,
      lazer: true,
      ...(clockRate !== 1 ? { clockRate } : {}),
    }).calculate(map).stars;
    return Number.isFinite(stars) ? stars : null;
  } catch (e) {
    console.error(`[difficulty] map ${beatmapId} not calculated:`, e);
    return null;
  } finally {
    map?.free();
  }
}

/**
 * A stored score's hit counts, translated to rosu's per-ruleset fields.
 * The slider fields are only passed when the score actually tracked them
 * (a stable score has none — passing 0 would count every slider as dropped).
 */
export function perfHits(
  rulesetId: number,
  statistics: string
): Record<string, number> | null {
  let st: Record<string, number>;
  try {
    st = JSON.parse(statistics || "{}") as Record<string, number>;
  } catch {
    return null;
  }
  if (!st || typeof st !== "object" || Object.keys(st).length === 0) return null;
  const n = (k: string) => st[k] ?? 0;
  const opt = (k: string, f: string) => (st[k] != null ? { [f]: st[k] } : {});
  switch (rulesetId) {
    case 1:
      return { n300: n("great"), n100: n("ok"), misses: n("miss") };
    case 2:
      return {
        n300: n("great"), n100: n("large_tick_hit"), n50: n("small_tick_hit"),
        nKatu: n("small_tick_miss"), misses: n("miss"),
      };
    case 3:
      return {
        nGeki: n("perfect"), n300: n("great"), nKatu: n("good"),
        n100: n("ok"), n50: n("meh"), misses: n("miss"),
      };
    default:
      return {
        n300: n("great"), n100: n("ok"), n50: n("meh"), misses: n("miss"),
        ...opt("slider_tail_hit", "sliderEndHits"),
        ...opt("large_tick_hit", "largeTickHits"),
        ...opt("small_tick_hit", "smallTickHits"),
      };
  }
}

/**
 * pp of a play the API leaves without one (loved map, unranked mods),
 * computed like the rating above: real mods and rate, the score's own hit
 * counts. Null when the map cannot be read — or when the score carries no
 * hit counts at all: generated "best case" hitresults from the accuracy
 * alone were off by 5x on low-accuracy plays, worse than showing nothing.
 */
export async function localPp(
  beatmapId: number,
  mods: ModRef[],
  rulesetId: number,
  score: { statistics: string; accuracy: number; maxCombo: number }
): Promise<number | null> {
  const hits = perfHits(rulesetId, score.statistics);
  if (!hits) return null;
  const content = await osuFile(beatmapId);
  if (!content) return null;
  let map: Beatmap | null = null;
  try {
    map = new Beatmap(content);
    if ((map.mode as number) !== rulesetId) map.convert(rulesetId as GameMode, mods);
    if (map.isSuspicious()) return null;
    const clockRate = computeRate(mods as Parameters<typeof computeRate>[0]);
    const pp = new Performance({
      mods,
      lazer: true,
      ...(clockRate !== 1 ? { clockRate } : {}),
      combo: score.maxCombo,
      ...hits,
    }).calculate(map).pp;
    return Number.isFinite(pp) ? pp : null;
  } catch (e) {
    console.error(`[difficulty] map ${beatmapId} pp not calculated:`, e);
    return null;
  } finally {
    map?.free();
  }
}
