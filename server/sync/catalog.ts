/**
 * Beatmap catalog. Enumerated from the osu! API `/beatmapsets/search`,
 * sliced by rank year (the search caps at ~10k SETS per query; no year has
 * ever exceeded ~5.5k sets, so yearly slices are always complete). A
 * follow-up enrichment pass via `/beatmaps?ids[]=` (50/req) fills in
 * max_combo and up-to-date star ratings.
 */
import { getDb, setState, getState, transaction } from "../db/db.js";
import { config } from "../config.js";
import {
  getBeatmapsByIds,
  getBeatmapsetById,
  limiter,
  searchBeatmapsets,
} from "../osu/api.js";
import { RetryableError } from "../osu/rateLimiter.js";
import type { ApiBeatmap, ApiBeatmapset } from "../osu/types.js";

const KEEP_STATUSES = new Set([1, 2, 4]); // ranked, approved, loved

// ---------- Common upserts ----------

function upsertSetStmt() {
  return getDb().prepare(`
    INSERT INTO beatmapsets (id, artist, artist_unicode, title, title_unicode,
      creator, creator_id, source, tags, status, ranked_date, submitted_date,
      download_disabled)
    VALUES (@id, @artist, @artist_unicode, @title, @title_unicode,
      @creator, @creator_id, @source, @tags, @status, @ranked_date, @submitted_date,
      @download_disabled)
    ON CONFLICT(id) DO UPDATE SET
      artist = excluded.artist, title = excluded.title, creator = excluded.creator,
      status = excluded.status, ranked_date = excluded.ranked_date, tags = excluded.tags,
      download_disabled = excluded.download_disabled
  `);
}

function upsertMapStmt() {
  return getDb().prepare(`
    INSERT INTO beatmaps (id, beatmapset_id, ruleset, version, status,
      total_length, hit_length, bpm, cs, ar, od, hp, star_rating,
      count_circles, count_sliders, count_spinners, last_updated, checksum)
    VALUES (@id, @beatmapset_id, @ruleset, @version, @status,
      @total_length, @hit_length, @bpm, @cs, @ar, @od, @hp, @star_rating,
      @count_circles, @count_sliders, @count_spinners, @last_updated, @checksum)
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version, status = excluded.status,
      star_rating = excluded.star_rating, bpm = excluded.bpm,
      cs = excluded.cs, ar = excluded.ar, od = excluded.od, hp = excluded.hp,
      total_length = excluded.total_length, last_updated = excluded.last_updated,
      checksum = COALESCE(excluded.checksum, beatmaps.checksum)
  `);
}

// ---------- Delta: new ranked/loved maps ----------

/**
 * Catches up on beatmapsets newly ranked/loved since the last pass.
 * Walks /beatmapsets/search sorted by rank date DESC and stops as soon as a
 * full page is already known => only a few requests per day.
 * Returns the ids of the new osu! standard diffs (to enrich/backfill).
 */
export async function updateCatalogDelta(
  onProgress?: (msg: string) => void
): Promise<number[]> {
  const db = getDb();
  const known = db.prepare("SELECT 1 FROM beatmapsets WHERE id = ?");
  const setStmt = upsertSetStmt();
  const mapStmt = upsertMapStmt();
  const newBeatmapIds: number[] = [];

  for (const category of ["ranked", "loved"] as const) {
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const res = await searchBeatmapsets(category, cursor, "low", "ranked_desc");
      let newInPage = 0;
      transaction(() => {
        for (const set of res.beatmapsets) {
          const isNew = !known.get(set.id);
          if (isNew) newInPage++;
          setStmt.run(apiSetToRow(set));
          for (const bm of set.beatmaps ?? []) {
            if (bm.mode_int !== 0 || !KEEP_STATUSES.has(bm.ranked)) continue;
            mapStmt.run(apiMapToRow(bm));
            if (isNew) newBeatmapIds.push(bm.id);
          }
        }
      });
      cursor = res.cursor_string;
      onProgress?.(`delta ${category}: +${newBeatmapIds.length} diffs...`);
      if (newInPage === 0 || !cursor || res.beatmapsets.length === 0) break;
    }
  }
  setState("catalog_delta_at", new Date().toISOString());
  return newBeatmapIds;
}

// ---------- Mega-collabs: sets > 100 diffs (truncated API payload) ----------

/**
 * The v2 API caps `beatmaps[]` at ~100 diffs per set (search AND lookup):
 * mega-collabs like "Yuki wa Naniiro" (~170 diffs) come back truncated.
 * Fallback: the set's web page embeds the FULL JSON in
 * <script id="json-beatmapset">. We only scrape these rare sets (a handful in
 * the whole game), going through the global rate limiter to be polite.
 */
export async function fetchBeatmapsetFromWeb(
  setId: number
): Promise<ApiBeatmapset | null> {
  return limiter.schedule(async () => {
    const res = await fetch(`https://osu.ppy.sh/beatmapsets/${setId}`, {
      headers: { "User-Agent": config.userAgent, Accept: "text/html" },
    });
    if (res.status === 404) return null;
    if (res.status === 429 || res.status >= 500)
      throw new RetryableError(`web ${res.status}`);
    if (!res.ok) throw new Error(`web ${res.status} on beatmapsets/${setId}`);
    const html = await res.text();
    const m = html.match(
      /<script id="json-beatmapset"[^>]*>\s*(\{[\s\S]*?\})\s*<\/script>/
    );
    if (!m) return null;
    return JSON.parse(m[1]) as ApiBeatmapset;
  }, "low");
}

/** mode_int can be missing in the web page JSON: fall back to `mode`. */
function modeIntOf(bm: ApiBeatmap & { mode?: string }): number {
  if (bm.mode_int != null) return bm.mode_int;
  return { osu: 0, taiko: 1, fruits: 2, mania: 3 }[bm.mode ?? ""] ?? -1;
}

/** Upsert a full set; returns the ids of the new std diffs. */
function upsertFullSet(set: ApiBeatmapset): number[] {
  const db = getDb();
  const setStmt = upsertSetStmt();
  const mapStmt = upsertMapStmt();
  const knownDiff = db.prepare("SELECT 1 FROM beatmaps WHERE id = ?");
  const newIds: number[] = [];
  transaction(() => {
    setStmt.run(apiSetToRow(set));
    for (const bm of set.beatmaps ?? []) {
      if (modeIntOf(bm) !== 0 || !KEEP_STATUSES.has(bm.ranked)) continue;
      const isNew = !knownDiff.get(bm.id);
      mapStmt.run(apiMapToRow(bm));
      if (bm.max_combo != null)
        db.prepare("UPDATE beatmaps SET max_combo = ? WHERE id = ?").run(
          bm.max_combo,
          bm.id
        );
      if (isNew) newIds.push(bm.id);
    }
  });
  return newIds;
}

/** Number of ranked/approved/loved std diffs in a set payload. */
export function stdDiffCount(set: ApiBeatmapset | null): number {
  return (set?.beatmaps ?? []).filter(
    (b) => modeIntOf(b) === 0 && KEEP_STATUSES.has(b.ranked)
  ).length;
}

/**
 * Aggressive import of ONE set: tries the API, then the web page if the API
 * doesn't see it or returns 0 std diffs (sets delisted from search, or even
 * from lookup).
 */
export async function importOneSet(
  setId: number
): Promise<{ source: "api" | "web" | null; newIds: number[] }> {
  let set = await getBeatmapsetById(setId);
  let source: "api" | "web" | null = set ? "api" : null;
  if (!set || stdDiffCount(set) === 0) {
    const webSet = await fetchBeatmapsetFromWeb(setId);
    if (webSet && stdDiffCount(webSet) > 0) {
      set = webSet;
      source = "web";
    }
  }
  if (!set) return { source: null, newIds: [] };
  const newIds = upsertFullSet(set);
  getDb()
    .prepare("UPDATE beatmapsets SET checked_at = datetime('now') WHERE id = ?")
    .run(setId);
  return { source, newIds };
}

/**
 * Repairs sets suspected of truncation (>= 100 known std diffs) by fetching
 * the full list from the web page.
 * Returns the ids of the newly discovered diffs.
 */
export async function repairOversizedSets(
  onProgress?: (msg: string) => void
): Promise<number[]> {
  const db = getDb();
  const suspects = db
    .prepare(
      `SELECT beatmapset_id AS id, COUNT(*) n FROM beatmaps
       WHERE ruleset = 0 GROUP BY beatmapset_id HAVING n >= 100`
    )
    .all() as { id: number; n: number }[];
  if (suspects.length === 0) return [];
  onProgress?.(`Mega-collabs: ${suspects.length} set(s) to check via the web page...`);

  const newIds: number[] = [];
  for (const s of suspects) {
    try {
      const set = await fetchBeatmapsetFromWeb(s.id);
      if (!set) continue;
      newIds.push(...upsertFullSet(set));
      onProgress?.(
        `Mega-collabs: set ${s.id} → ${set.beatmaps?.length ?? 0} diffs (${newIds.length} new in total)`
      );
    } catch (e) {
      console.error(`[big-sets] set ${s.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return newIds;
}

// ---------- Targeted year verification (fast, no dump) ----------

/**
 * Finds delisted sets of a year WITHOUT re-downloading the dump: the local
 * beatmapsets table is already complete (built from the dump's exhaustive
 * table). We re-enumerate the search over the year (~100 requests); any local
 * set of the year absent from the results = delisted => individual check via
 * API then web page, importing the missing diffs.
 */
export async function verifyYear(
  year: number,
  onProgress?: (msg: string) => void
): Promise<{
  searchSets: number;
  localSets: number;
  delisted: { id: number; artist: string; title: string; source: string; newDiffs: number }[];
  newBeatmapIds: number[];
}> {
  const db = getDb();
  const seen = new Set<number>();

  // IMPORTANT: we enumerate all 4 modes — a taiko/mania/catch-only set does
  // not appear in the std search (m=0) and would wrongly be treated as
  // delisted (thousands of useless individual checks).
  const collect = async (
    category: "ranked" | "loved",
    query: string,
    mode: number
  ): Promise<number> => {
    let cursor: string | null = null;
    let announced = -1;
    for (;;) {
      const page = await searchBeatmapsets(
        category, cursor, "low", "ranked_asc", query, mode
      );
      if (announced < 0) announced = page.total;
      for (const set of page.beatmapsets) seen.add(set.id);
      cursor = page.cursor_string;
      onProgress?.(
        `verify ${year} [${category} m=${mode}]: ${seen.size} sets seen in the search...`
      );
      if (!cursor || page.beatmapsets.length === 0) break;
    }
    return announced;
  };

  for (const mode of [0, 1, 2, 3]) {
    for (const category of ["ranked", "loved"] as const) {
      // No year has ever exceeded ~5.5k SETS (the ~10k search cap applies to
      // sets, not diffs), so a single yearly query is always complete.
      await collect(
        category,
        `ranked>=${year}-01-01 ranked<${year + 1}-01-01`,
        mode
      );
    }
  }

  const locals = db
    .prepare(
      `SELECT id, artist, title FROM beatmapsets
       WHERE status IN (1, 2, 4) AND strftime('%Y', ranked_date) = ?`
    )
    .all(String(year)) as { id: number; artist: string; title: string }[];

  const suspects = locals.filter((l) => !seen.has(l.id));
  onProgress?.(
    `verify ${year}: ${locals.length} local sets, ${seen.size} seen in search, ${suspects.length} delisted to check...`
  );

  const delisted: { id: number; artist: string; title: string; source: string; newDiffs: number }[] = [];
  const newBeatmapIds: number[] = [];
  for (const s of suspects) {
    try {
      const { source, newIds } = await importOneSet(s.id);
      newBeatmapIds.push(...newIds);
      delisted.push({
        id: s.id,
        artist: s.artist,
        title: s.title,
        source: source ?? "not found (removed from osu!)",
        newDiffs: newIds.length,
      });
      onProgress?.(
        `verify ${year}: ${s.artist} - ${s.title} => ${source ?? "404"} (+${newIds.length} diffs)`
      );
    } catch (e) {
      delisted.push({
        id: s.id,
        artist: s.artist,
        title: s.title,
        source: `error: ${e instanceof Error ? e.message : e}`,
        newDiffs: 0,
      });
    }
  }
  return { searchSets: seen.size, localSets: locals.length, delisted, newBeatmapIds };
}

// ---------- Source 2: API /beatmapsets/search ----------

export async function importCatalogFromApi(
  onProgress?: (msg: string) => void,
  opts?: { reset?: boolean }
): Promise<{ sets: number; maps: number }> {
  getDb();
  const setStmt = upsertSetStmt();
  const mapStmt = upsertMapStmt();
  const counts = { sets: 0, maps: 0 };

  /**
   * Enumerates one "slice" (search query), cursor persisted => resumable.
   * Returns the set total announced by the API for this query (-1 if the
   * slice was already finished).
   */
  const enumerateSlice = async (
    category: "ranked" | "loved",
    key: string,
    query: string | null
  ): Promise<number> => {
    if (opts?.reset) setState(key, "");
    let cursor: string | null = opts?.reset ? null : getState(key);
    if (cursor === "") cursor = null;
    if (cursor === "DONE") return -1;
    let announced = -1;
    for (;;) {
      const page = await searchBeatmapsets(
        category,
        cursor,
        "low",
        "ranked_asc",
        query ?? undefined
      );
      if (announced < 0) announced = page.total;
      transaction(() => {
        for (const set of page.beatmapsets) {
          setStmt.run(apiSetToRow(set));
          counts.sets++;
          for (const bm of set.beatmaps ?? []) {
            if (bm.mode_int !== 0 || !KEEP_STATUSES.has(bm.ranked)) continue;
            mapStmt.run(apiMapToRow(bm));
            counts.maps++;
          }
        }
      });
      cursor = page.cursor_string;
      setState(key, cursor ?? "DONE");
      onProgress?.(`${category} [${query ?? "base"}]: ${counts.sets} sets imported...`);
      if (!cursor || page.beatmapsets.length === 0) break;
    }
    return announced;
  };

  // IMPORTANT: the osu!web search caps at ~10,000 results per query, cursor
  // included. The cap applies to SETS and no year has ever exceeded ~5.5k
  // sets, so one slice per rank year is always complete. Strategy:
  //  1) "base" pass with no date filter — catches sets with no ranked_date
  //     (within the cap, ranked_asc sort);
  //  2) slices by rank year (`ranked>=Y ranked<Y+1`).
  const START_YEAR = 2007;
  const endYear = new Date().getUTCFullYear();

  for (const category of ["ranked", "loved"] as const) {
    await enumerateSlice(category, `catalog_api_cursor_${category}_base`, null);

    for (let year = START_YEAR; year <= endYear; year++) {
      const yearKey = `catalog_api_cursor_${category}_${year}`;
      await enumerateSlice(
        category,
        yearKey,
        `ranked>=${year}-01-01 ranked<${year + 1}-01-01`
      );
      // the current year (and the base pass) are re-scanned on the next pass
      if (year === endYear) setState(yearKey, "");
    }
    setState(`catalog_api_cursor_${category}_base`, "");
  }
  setState("catalog_imported_at", new Date().toISOString());
  return counts;
}

function apiSetToRow(s: ApiBeatmapset) {
  return {
    id: s.id,
    artist: s.artist,
    artist_unicode: s.artist_unicode ?? null,
    title: s.title,
    title_unicode: s.title_unicode ?? null,
    creator: s.creator,
    creator_id: s.user_id,
    source: s.source ?? null,
    tags: s.tags ?? null,
    status: s.ranked,
    ranked_date: s.ranked_date ?? null,
    submitted_date: s.submitted_date ?? null,
    download_disabled: s.availability?.download_disabled ? 1 : 0,
  };
}

function apiMapToRow(b: ApiBeatmap) {
  return {
    id: b.id,
    beatmapset_id: b.beatmapset_id,
    ruleset: b.mode_int,
    version: b.version,
    status: b.ranked,
    total_length: b.total_length,
    hit_length: b.hit_length,
    bpm: b.bpm,
    cs: b.cs,
    ar: b.ar,
    od: b.accuracy,
    hp: b.drain,
    star_rating: b.difficulty_rating,
    count_circles: b.count_circles ?? null,
    count_sliders: b.count_sliders ?? null,
    count_spinners: b.count_spinners ?? null,
    last_updated: b.last_updated ?? null,
    checksum: b.checksum ?? null,
  };
}

// ---------- max_combo enrichment (50 maps / request) ----------

export async function enrichMaxCombo(
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean
): Promise<number> {
  const db = getDb();
  const update = db.prepare(
    `UPDATE beatmaps SET max_combo = @max_combo, star_rating = @sr,
       count_circles = COALESCE(@cc, count_circles),
       count_sliders = COALESCE(@cs, count_sliders),
       count_spinners = COALESCE(@csp, count_spinners),
       checksum = COALESCE(@checksum, checksum)
     WHERE id = @id`
  );
  const total = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM beatmaps WHERE ruleset = 0 AND (max_combo IS NULL OR checksum IS NULL)"
      )
      .get() as { c: number }
  ).c;
  let done = 0;
  for (;;) {
    if (shouldStop?.()) break;
    const ids = (
      db
        .prepare(
          "SELECT id FROM beatmaps WHERE ruleset = 0 AND (max_combo IS NULL OR checksum IS NULL) LIMIT 50"
        )
        .all() as { id: number }[]
    ).map((r) => r.id);
    if (ids.length === 0) break;
    const beatmaps = await getBeatmapsByIds(ids);
    const found = new Set<number>();
    transaction(() => {
      for (const b of beatmaps) {
        found.add(b.id);
        update.run({
          id: b.id,
          max_combo: b.max_combo ?? 0,
          sr: b.difficulty_rating ?? null,
          cc: b.count_circles ?? null,
          cs: b.count_sliders ?? null,
          csp: b.count_spinners ?? null,
          checksum: b.checksum ?? null,
        });
      }
      // ids not returned (deleted maps?): max_combo = 0 to avoid looping
      for (const id of ids)
        if (!found.has(id))
          update.run({ id, max_combo: 0, sr: null, cc: null, cs: null, csp: null });
    });
    done += ids.length;
    onProgress?.(done, total);
  }
  return done;
}
