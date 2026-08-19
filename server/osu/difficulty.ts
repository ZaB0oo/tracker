import fs from "node:fs";
import path from "node:path";
import { Beatmap, Difficulty, GameMode } from "rosu-pp-js";
import { config } from "../config.js";
import type { ModRef } from "../logic/score.js";

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
    const stars = new Difficulty({ mods, lazer: true }).calculate(map).stars;
    return Number.isFinite(stars) ? stars : null;
  } catch (e) {
    console.error(`[difficulty] map ${beatmapId} not calculated:`, e);
    return null;
  } finally {
    map?.free();
  }
}
