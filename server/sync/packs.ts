/**
 * Official beatmap packs, synced locally so the dashboard can show pack
 * completion (played / completed / full FC per pack, like the classic
 * completionist pack pages) computed from YOUR local scores.
 *
 * The definitions are an opt-in one-off import (~1 request per pack, about an
 * hour for the ~3000 packs at the default rate — resumable per pack via
 * `synced_at`), then a cheap monthly delta keeps them fresh.
 */
import { getDb } from "../db/db.js";
import { getPacks, getPackSets } from "../osu/api.js";

export const PACK_TYPES = [
  "standard",
  "featured",
  "tournament",
  "loved",
  "chart",
  "theme",
  "artist",
] as const;

let packsSyncRunning = false;
export function isPacksSyncRunning(): boolean {
  return packsSyncRunning;
}

/** Upserts one page worth of pack headers. */
function upsertHeaders(
  packs: { tag: string; name: string; date?: string; ruleset_id: number | null; url?: string }[],
  type: string
): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO packs (tag, name, type, ruleset, url, date)
     VALUES (@tag, @name, @type, @ruleset, @url, @date)
     ON CONFLICT(tag) DO UPDATE SET
       name = excluded.name, type = excluded.type,
       ruleset = excluded.ruleset, url = excluded.url, date = excluded.date`
  );
  for (const p of packs)
    stmt.run({
      tag: p.tag,
      name: p.name,
      type,
      ruleset: p.ruleset_id ?? null,
      url: p.url ?? null,
      date: p.date ?? null,
    });
}

/** Fetches the contents of every pack still missing them (resumable). */
async function fillContents(onProgress?: (msg: string) => void): Promise<number> {
  const db = getDb();
  const pending = db
    .prepare("SELECT tag FROM packs WHERE synced_at IS NULL ORDER BY tag")
    .all() as { tag: string }[];
  const ins = db.prepare(
    "INSERT OR IGNORE INTO pack_sets (tag, beatmapset_id) VALUES (?, ?)"
  );
  const done = db.prepare("UPDATE packs SET synced_at = ? WHERE tag = ?");
  let filled = 0;
  for (const { tag } of pending) {
    try {
      const ids = await getPackSets(tag);
      for (const id of ids) ins.run(tag, id);
      done.run(new Date().toISOString(), tag);
      filled++;
      if (filled % 25 === 0)
        onProgress?.(`packs: ${filled}/${pending.length} contents fetched`);
    } catch (e) {
      console.error(`[packs] ${tag}:`, e instanceof Error ? e.message : e);
    }
  }
  return filled;
}

/**
 * Full import: list every pack of every type, then fill the missing contents.
 * null = already running.
 */
export async function importPacks(
  onProgress?: (msg: string) => void
): Promise<number | null> {
  if (packsSyncRunning) return null;
  packsSyncRunning = true;
  try {
    for (const type of PACK_TYPES) {
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await getPacks(type, cursor);
        upsertHeaders(page.beatmap_packs, type);
        cursor = page.cursor_string;
        pages++;
      } while (cursor);
      onProgress?.(`packs: ${type} listed (${pages} page(s))`);
    }
    const filled = await fillContents(onProgress);
    onProgress?.(`packs import done: ${filled} pack(s) fetched`);
    return filled;
  } finally {
    packsSyncRunning = false;
  }
}

/**
 * Cheap catch-up: one page per type finds the newest packs (they are listed
 * newest first); anything unknown gets its contents fetched. No-op before the
 * initial import (packs table empty = the user never opted in).
 */
export async function refreshPacksDelta(
  onProgress?: (msg: string) => void
): Promise<number> {
  const db = getDb();
  const count = (
    db.prepare("SELECT COUNT(*) c FROM packs").get() as { c: number }
  ).c;
  if (count === 0 || packsSyncRunning) return 0;
  packsSyncRunning = true;
  try {
    for (const type of PACK_TYPES) {
      const page = await getPacks(type, null);
      upsertHeaders(page.beatmap_packs, type);
    }
    const filled = await fillContents(onProgress);
    if (filled > 0) onProgress?.(`packs: +${filled} new pack(s)`);
    return filled;
  } finally {
    packsSyncRunning = false;
  }
}
