/**
 * Beatmap catalog. Enumerated from the osu! API `/beatmapsets/search`,
 * sliced by rank year (the search caps at ~10k SETS per query; no year has
 * ever exceeded ~5.5k sets, so yearly slices are always complete). A
 * follow-up enrichment pass via `/beatmaps?ids[]=` (50/req) fills in
 * max_combo and up-to-date star ratings.
 */
import { catalogRulesets, getDb, getStartedRulesets, setState, getState, sqlIn, transaction } from "../db/db.js";
import { config } from "../config.js";
import {
  getBeatmapsByIds,
  getBeatmapsetById,
  limiter,
  searchBeatmapsets,
} from "../osu/api.js";
import { RetryableError } from "../osu/rateLimiter.js";
import { poolGrowth, poolWhere, shortModeName } from "../logic/rulesets.js";
import { bumpScoresVersion } from "../logic/scoreSql.js";
import type { ApiBeatmap, ApiBeatmapset } from "../osu/types.js";

const KEEP_STATUSES = new Set([1, 2, 4]); // ranked, approved, loved

// A set payload this big is probably truncated by the API's ~100-diff cap
// (the cap counts ALL modes, so a mixed set truncates below its own total).
const TRUNCATION_SUSPECT = 80;

/**
 * Pool size per STARTED ruleset, counted exactly like the UI totals
 * (poolWhere => converts included, ranked/approved/loved only). Index-only
 * COUNTs (idx_beatmaps_ruleset_status), so calling this inside a per-set loop
 * costs nothing next to the API request it reports on. Feed the snapshot to
 * poolGrowth() to report what really entered the pools.
 */
export function poolCounts(): Map<number, number> {
  const db = getDb();
  const counts = new Map<number, number>();
  for (const m of getStartedRulesets()) {
    const row = db
      .prepare(
        `SELECT COUNT(*) c FROM beatmaps b
         WHERE ${poolWhere(m, undefined)} AND b.status IN (1, 2, 4)`
      )
      .get() as { c: number };
    counts.set(m, row.c);
  }
  return counts;
}

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
  const knownDiff = db.prepare("SELECT 1 FROM beatmaps WHERE id = ?");
  const setStmt = upsertSetStmt();
  const mapStmt = upsertMapStmt();
  const newBeatmapIds: number[] = [];
  const before = poolCounts();

  // one delta walk per CATALOG ruleset — std included when it only feeds the
  // converts of another mode, otherwise newly ranked converts never arrive
  for (const mode of catalogRulesets()) {
    for (const category of ["ranked", "loved"] as const) {
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const res = await searchBeatmapsets(
          category,
          cursor,
          "low",
          "ranked_desc",
          undefined,
          mode
        );
        // "already-known territory" is measured on THIS mode's DIFFS, never on
        // the sets: the walks run one mode after another, so the first walk
        // already stored every new hybrid set — a set-level test made every
        // later mode stop on its first page and skip its own new diffs.
        let newInPage = 0;
        transaction(() => {
          for (const set of res.beatmapsets) {
            setStmt.run(apiSetToRow(set));
            for (const bm of set.beatmaps ?? []) {
              if (bm.mode_int !== mode || !KEEP_STATUSES.has(bm.ranked)) continue;
              const isNewDiff = !knownDiff.get(bm.id);
              mapStmt.run(apiMapToRow(bm));
              if (isNewDiff) {
                newBeatmapIds.push(bm.id);
                newInPage++;
              }
            }
          }
        });
        cursor = res.cursor_string;
        onProgress?.(
          `new ${shortModeName(mode)} ${category} maps: ${poolGrowth(before, poolCounts()).label}`
        );
        if (newInPage === 0 || !cursor || res.beatmapsets.length === 0) break;
      }
    }
  }
  setState("catalog_delta_at", new Date().toISOString());
  // catalog writes change what the cached payloads say (pool totals, status
  // filters, new maps): invalidate them like a score write would
  bumpScoresVersion();
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

/**
 * Upsert a full set; returns the ids of the newly stored diffs.
 * Stores the diffs of EVERY ruleset, not just the active ones: nothing ever
 * revisits a set that already has a row, so a diff dropped because its mode
 * was inactive at lookup time would stay missing forever. Rows of non-started
 * modes cost a few bytes and no API call; every reader filters by ruleset.
 */
function upsertFullSet(set: ApiBeatmapset): number[] {
  const db = getDb();
  const setStmt = upsertSetStmt();
  const mapStmt = upsertMapStmt();
  const knownDiff = db.prepare("SELECT 1 FROM beatmaps WHERE id = ?");
  const newIds: number[] = [];
  transaction(() => {
    setStmt.run(apiSetToRow(set));
    for (const bm of set.beatmaps ?? []) {
      if (modeIntOf(bm) < 0 || !KEEP_STATUSES.has(bm.ranked)) continue;
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
  // a status/SR change on an existing map matters as much as a new one:
  // the caches filtering on b.status must not serve the old catalog
  bumpScoresVersion();
  return newIds;
}

/**
 * Number of diffs a channel returned that we would store (ranked/approved/loved,
 * any ruleset) — i.e. "did this channel see anything usable for this set?".
 */
export function keptDiffCount(set: ApiBeatmapset | null): number {
  return (set?.beatmaps ?? []).filter(
    (b) => modeIntOf(b) >= 0 && KEEP_STATUSES.has(b.ranked)
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
  // The ~100-diff payload cap also hits the LOOKUP: a mega-collab comes back
  // truncated and its cut-off diffs then look like they do not exist at all
  // (they came back "missing" on every dump run). Cross-check the web page
  // whenever the payload is that big — same threshold as repairOversizedSets.
  const maybeTruncated = (set?.beatmaps?.length ?? 0) >= TRUNCATION_SUSPECT;
  if (!set || maybeTruncated || keptDiffCount(set) === 0) {
    const webSet = await fetchBeatmapsetFromWeb(setId);
    // keep the web version only when it sees at least as much as the API did
    if (
      webSet &&
      keptDiffCount(webSet) > 0 &&
      (webSet.beatmaps?.length ?? 0) >= (set?.beatmaps?.length ?? 0)
    ) {
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
  // the ~100-diff API cap applies to the WHOLE set payload (all modes): a
  // mixed 60 std + 50 catch set truncates too — suspect anything close
  const suspects = db
    .prepare(
      `SELECT beatmapset_id AS id, COUNT(*) n FROM beatmaps
       GROUP BY beatmapset_id HAVING n >= ${TRUNCATION_SUSPECT}`
    )
    .all() as { id: number; n: number }[];
  if (suspects.length === 0) return [];
  onProgress?.(`Mega-collabs: ${suspects.length} set(s) to check via the web page...`);

  const before = poolCounts();
  const newIds: number[] = [];
  for (const s of suspects) {
    try {
      const set = await fetchBeatmapsetFromWeb(s.id);
      if (!set) continue;
      newIds.push(...upsertFullSet(set));
      onProgress?.(
        `Mega-collabs: set ${s.id} → ${set.beatmaps?.length ?? 0} diffs (${poolGrowth(before, poolCounts()).label} so far)`
      );
    } catch (e) {
      console.error(`[big-sets] set ${s.id}:`, e instanceof Error ? e.message : e);
    }
  }
  return newIds;
}

// ---------- Delisted-sets re-check (part of the catalog repair) ----------
// Hybrid sets whose non-std diffs were dropped while only std was active, or
// whose diff list changed since: re-lookup every locally-known DMCA set
// (download_disabled only: the search enumeration cannot see them, so the
// normal delta/full-scan never fixes them). The truly-unknown delisted sets
// are covered by the data-dump verification (dump.ts).
export async function recheckDelistedSets(
  onProgress?: (msg: string) => void
): Promise<number> {
  const db = getDb();
  const modes = getStartedRulesets();
  const suspects = db
    .prepare("SELECT id FROM beatmapsets WHERE download_disabled = 1 ORDER BY id")
    .all() as { id: number }[];
  const seedStmt = db.prepare(
    `INSERT OR IGNORE INTO beatmap_user (beatmap_id, ruleset)
     SELECT id, ? FROM beatmaps
     WHERE beatmapset_id = ? AND (ruleset = ? OR ruleset = 0)`
  );
  const before = poolCounts();
  let done = 0;
  for (const s of suspects) {
    try {
      const r = await importOneSet(s.id);
      if (r.newIds.length) for (const m of modes) seedStmt.run(m, s.id, m);
    } catch (e) {
      console.error(`[repair] set ${s.id}:`, e instanceof Error ? e.message : e);
    }
    done++;
    if (done % 50 === 0)
      onProgress?.(
        `delisted re-check: ${done}/${suspects.length} sets (${poolGrowth(before, poolCounts()).label})`
      );
  }
  const g = poolGrowth(before, poolCounts());
  onProgress?.(`delisted re-check done: ${done} sets (${g.label})`);
  return g.total;
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

// Mode currently being enumerated (sync-bar busy label); null outside runs.
let enumMode: number | null = null;
export function currentEnumMode(): number | null {
  return enumMode;
}

export async function importCatalogFromApi(
  onProgress?: (msg: string) => void,
  opts?: { reset?: boolean; modes?: number[] }
): Promise<{ sets: number; maps: number }> {
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
    query: string | null,
    mode: number,
    /** what the user sees for this slice: "all years" or "2015" */
    slice: string
  ): Promise<number> => {
    enumMode = mode;
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
        query ?? undefined,
        mode
      );
      if (announced < 0) announced = page.total;
      transaction(() => {
        for (const set of page.beatmapsets) {
          setStmt.run(apiSetToRow(set));
          counts.sets++;
          for (const bm of set.beatmaps ?? []) {
            if (bm.mode_int !== mode || !KEEP_STATUSES.has(bm.ranked)) continue;
            mapStmt.run(apiMapToRow(bm));
            counts.maps++;
          }
        }
      });
      cursor = page.cursor_string;
      setState(key, cursor ?? "DONE");
      onProgress?.(
        `${shortModeName(mode)} ${category}, ${slice}: ${counts.sets} sets read`
      );
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
  const SEARCH_CAP = 10_000;

  // one full enumeration per CATALOG ruleset; mode 0 keeps the historical
  // cursor keys (existing installs must not re-enumerate their std catalog).
  // Order: the modes the user actually plays first, emptiest first (a freshly
  // started mode must not wait behind a base-slice re-scan before its first
  // maps appear), then a std catalog kept only as a convert source, last.
  const db2 = getDb();
  const modeCount = (m: number) =>
    (
      db2.prepare("SELECT COUNT(*) c FROM beatmaps WHERE ruleset = ?").get(m) as {
        c: number;
      }
    ).c;
  const started = new Set(getStartedRulesets());
  const wanted = opts?.modes?.length
    ? catalogRulesets().filter((m) => opts.modes!.includes(m))
    : catalogRulesets();
  const orderedModes = [...wanted].sort(
    (a, b) =>
      Number(started.has(b)) - Number(started.has(a)) || modeCount(a) - modeCount(b)
  );
  for (const mode of orderedModes) {
    const suffix = mode === 0 ? "" : `_m${mode}`;
    for (const category of ["ranked", "loved"] as const) {
      const setsBefore = counts.sets;
      const baseTotal = await enumerateSlice(
        category,
        `catalog_api_cursor_${category}${suffix}_base`,
        null,
        mode,
        "all years"
      );
      const walked = counts.sets - setsBefore;

      // The base pass has NO date filter: when it stays under the search cap it
      // just enumerated the WHOLE category, and the yearly slices below would
      // re-walk the very same sets (taiko/catch/mania all sit far under the cap
      // — ~300 duplicate requests per mode per pass). Only std needs slicing.
      // Any doubt keeps the slices: -1 = base finished on an earlier run (total
      // unknown), and the walked count is checked too so a surprising `total`
      // can never skip them.
      const needsSlices =
        baseTotal < 0 || baseTotal >= SEARCH_CAP || walked >= SEARCH_CAP;
      // Probe, and the answer to "are the slices needed for std at all?": the
      // announced total is itself clamped to the cap (Search::total() returns
      // min(hits, maxResults)), so only the WALKED count can tell whether a
      // cursor escapes the 10k window. walked > cap here = it does, and the
      // base pass alone would be exhaustive.
      if (needsSlices)
        onProgress?.(
          `${shortModeName(mode)} ${category}: ${walked} sets in one pass ` +
            `(search caps at ${SEARCH_CAP}), reading year by year`
        );
      for (let year = START_YEAR; needsSlices && year <= endYear; year++) {
        const yearKey = `catalog_api_cursor_${category}${suffix}_${year}`;
        await enumerateSlice(
          category,
          yearKey,
          `ranked>=${year}-01-01 ranked<${year + 1}-01-01`,
          mode,
          String(year)
        );
        // the current year (and the base pass) are re-scanned on the next pass
        if (year === endYear) setState(yearKey, "");
      }
      setState(`catalog_api_cursor_${category}${suffix}_base`, "");
    }
    // both categories (ranked AND loved) fully enumerated for this mode:
    // the self-heal resume keys off this flag
    if (mode !== 0) setState(`catalog_done_m${mode}`, "1");
  }
  setState("catalog_imported_at", new Date().toISOString());
  enumMode = null;
  bumpScoresVersion(); // the pool just changed shape: caches must rebuild
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

/**
 * Every import path ends with an enrichment, and they overlap (a repair while
 * the periodic tick enriches, a dump verify while a delta finishes…). Without
 * this guard each pass pulled the SAME `LIMIT 50` rows and re-fetched them:
 * three concurrent passes = three times the API budget for one job. Skipping is
 * safe — the running pass re-queries every iteration, so it picks up whatever
 * the caller just imported.
 */
let enrichRunning = false;

export async function enrichMaxCombo(
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean
): Promise<number> {
  if (enrichRunning) return 0;
  enrichRunning = true;
  try {
    return await enrichMaxComboInner(onProgress, shouldStop);
  } finally {
    enrichRunning = false;
  }
}

async function enrichMaxComboInner(
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean
): Promise<number> {
  const db = getDb();
  // star_rating: COALESCE — the "id not returned" branch below used to WIPE
  // the SR of existing maps (they dropped out of every star bucket)
  const update = db.prepare(
    `UPDATE beatmaps SET max_combo = @max_combo,
       star_rating = COALESCE(@sr, star_rating),
       count_circles = COALESCE(@cc, count_circles),
       count_sliders = COALESCE(@cs, count_sliders),
       count_spinners = COALESCE(@csp, count_spinners),
       checksum = COALESCE(@checksum, checksum)
     WHERE id = @id`
  );
  // catalog modes: a convert's own std row still needs its max_combo/checksum
  const modesIn = sqlIn(catalogRulesets());
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM beatmaps WHERE ruleset IN (${modesIn}) AND (max_combo IS NULL OR checksum IS NULL)`
      )
      .get() as { c: number }
  ).c;
  let done = 0;
  for (;;) {
    if (shouldStop?.()) break;
    const ids = (
      db
        .prepare(
          `SELECT id FROM beatmaps WHERE ruleset IN (${modesIn}) AND (max_combo IS NULL OR checksum IS NULL) LIMIT 50`
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
    // rows imported after `total` was measured can push done past it: report the
    // larger of the two rather than "40000/37057"
    onProgress?.(done, Math.max(total, done));
  }
  // max_combo / SR just changed on `done` maps: star buckets and combo
  // columns served from caches must recompute
  if (done > 0) bumpScoresVersion();
  return done;
}
