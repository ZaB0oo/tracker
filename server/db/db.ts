/**
 * SQLite via node:sqlite (built into Node >= 22.13): no native dependency to
 * compile, works everywhere (Windows included) with just `npm install`.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import {
  DEFAULT_MAP_CONDS,
  DEFAULT_SCORE_CONDS,
  type MetricParams,
} from "../logic/metrics.js";
import { backfillModMultipliers } from "../logic/modMultiplier.js";
import { withConvertSource } from "../logic/rulesets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Seed the default metrics once (Clears, any FC, Ranked score). */
function seedDefaultMetrics(d: DatabaseSync): void {
  // "Profile pp" default (added later): seeded once, on old and new DBs alike.
  const ppSeeded = d
    .prepare("SELECT value FROM sync_state WHERE key = 'metrics_seeded_pp'")
    .get();
  if (!ppSeeded) {
    const order =
      (d.prepare("SELECT COALESCE(MAX(sort_order), 0) m FROM metrics").get() as {
        m: number;
      }).m + 1;
    d.prepare("INSERT INTO metrics (name, params, sort_order) VALUES (?, ?, ?)").run(
      "Profile pp",
      JSON.stringify({
        kind: "pp",
        score: DEFAULT_SCORE_CONDS,
        map: DEFAULT_MAP_CONDS,
        progressMode: "milestone",
        step: 500,
        showEvolution: true,
      }),
      order
    );
    d.prepare(
      "INSERT OR REPLACE INTO sync_state(key, value) VALUES('metrics_seeded_pp', '1')"
    ).run();
  }

  const seeded = d
    .prepare("SELECT value FROM sync_state WHERE key = 'metrics_seeded'")
    .get();
  if (seeded) return;
  const mk = (over: Partial<MetricParams>): string =>
    JSON.stringify({
      kind: "count",
      score: DEFAULT_SCORE_CONDS,
      map: DEFAULT_MAP_CONDS,
      progressMode: "milestone",
      step: 1000,
      showEvolution: true,
      ...over,
    } satisfies MetricParams);
  const defaults: [string, string][] = [
    ["Clears", mk({ progressMode: "total" })],
    ["Full combos", mk({ score: { ...DEFAULT_SCORE_CONDS, fc: "any" }, progressMode: "total" })],
    ["Ranked score", mk({ kind: "ranked_score", step: 10_000_000_000 })],
  ];
  const ins = d.prepare(
    "INSERT INTO metrics (name, params, sort_order) VALUES (?, ?, ?)"
  );
  d.exec("BEGIN");
  defaults.forEach(([name, params], i) => ins.run(name, params, i));
  d.prepare(
    "INSERT OR REPLACE INTO sync_state(key, value) VALUES('metrics_seeded', '1')"
  ).run();
  d.exec("COMMIT");
}

let db: DatabaseSync | null = null;

/**
 * Staged DB import (Settings → Import database): the uploaded file waits as
 * `tracker.db.import` and is swapped in HERE, because this is the only place
 * that opens the database — and it must happen while nothing holds it. Doing it
 * from index.ts could never work: ESM evaluates every import first, and one of
 * them (osu/api.ts reading its rate limit) already opens the database, so the
 * swap hit its own handle (EBUSY on Windows) and the upload was discarded.
 */
function applyStagedImport(): void {
  const staged = `${config.dbPath}.import`;
  if (!fs.existsSync(staged)) return;
  try {
    // The WAL holds every recent transaction (easily hundreds of MB), so the
    // backup copies the three files, not just the .db: restoring means putting
    // .bak, .bak-wal and .bak-shm back as tracker.db*.
    for (const ext of ["", "-wal", "-shm"])
      if (fs.existsSync(config.dbPath + ext))
        fs.copyFileSync(config.dbPath + ext, `${config.dbPath}.bak${ext}`);
    // Order matters: move the LIVE trio aside FIRST — a lock (antivirus,
    // second instance) then aborts with everything intact. The old sequence
    // deleted the live WAL before the rename, so a locked .db lost its
    // uncheckpointed transactions.
    const old = `${config.dbPath}.old`;
    // A leftover .old means a previous attempt died between the two renames:
    // THAT file is the real database — restore it instead of deleting it.
    if (fs.existsSync(old) && !fs.existsSync(config.dbPath)) {
      for (const ext of ["", "-wal", "-shm"])
        if (fs.existsSync(old + ext)) fs.renameSync(old + ext, config.dbPath + ext);
      console.warn("[db] recovered the database left by an interrupted import");
    }
    for (const ext of ["", "-wal", "-shm"]) fs.rmSync(old + ext, { force: true });
    // sidecars move WITH their database: deleting them before the swap was
    // the very data loss this reorder is about
    const moved: string[] = [];
    for (const ext of ["", "-wal", "-shm"])
      if (fs.existsSync(config.dbPath + ext)) {
        fs.renameSync(config.dbPath + ext, old + ext);
        moved.push(ext);
      }
    try {
      fs.renameSync(staged, config.dbPath);
      // the new database owns the name now: the old sidecars must not be
      // reattached to it (their content is preserved in .old* and .bak*)
      for (const ext of ["-wal", "-shm"]) fs.rmSync(old + ext, { force: true });
      fs.rmSync(old, { force: true }); // superseded by the .bak trio
    } catch (e) {
      // put the previous database (and its WAL) back before reporting
      try {
        for (const ext of moved) fs.renameSync(old + ext, config.dbPath + ext);
      } catch {
        /* the .bak trio still holds everything */
      }
      throw e;
    }
    console.log(
      `[db] staged import applied (previous database saved as ${path.basename(config.dbPath)}.bak)`
    );
  } catch (e) {
    // The staged file is KEPT: it is the user's upload — possibly gigabytes —
    // and the usual cause is a lock, not a bad file (the upload already checked
    // the SQLite header), so the swap retries at the next start. Deleting it
    // here forced a full re-upload for a transient lock.
    const code = (e as NodeJS.ErrnoException).code;
    console.error(
      `[db] staged import NOT applied: ${e instanceof Error ? e.message : String(e)}`
    );
    console.error(
      code === "EBUSY" || code === "EPERM"
        ? `[db] another instance still has the database open. Close it (a second ` +
            `app window, or a dev server on the same data folder) and start again: ` +
            `your import is kept. Delete ${path.basename(staged)} to cancel it.`
        : `[db] your import is kept and will be retried at the next start. Delete ` +
            `${staged} to cancel it.`
    );
    console.error(
      `[db] your previous database (with its WAL) was restored in place; a ` +
        `full backup also exists as ${path.basename(config.dbPath)}.bak*`
    );
  }
}

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  applyStagedImport();
  // Opened into a LOCAL until the schema and the migrations have both gone
  // through. `db` used to be assigned first: when the schema threw, the throw
  // was swallowed upstream and every later call got that half-open handle
  // back, so the app ran on an unmigrated database forever, on every restart.
  const fresh = new DatabaseSync(config.dbPath);
  fresh.exec("PRAGMA journal_mode = WAL");
  fresh.exec("PRAGMA synchronous = NORMAL");
  fresh.exec("PRAGMA foreign_keys = OFF"); // bulk imports, order is not guaranteed
  // 64 MB page cache (default is 2 MB for a 250 MB+ database) and in-memory
  // temp b-trees: the dashboard aggregates group/sort over 150k+ rows.
  fresh.exec("PRAGMA cache_size = -65536");
  fresh.exec("PRAGMA temp_store = MEMORY");
  // Tables first, MIGRATIONS, then indexes. The indexes are written against
  // today's columns, several of which migrate() is the one to add — running
  // schema.sql in one go threw on any database older than them, before a
  // single migration had run. The file is plain DDL, one statement per `;`.
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const statements = schema.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  const isIndex = (s: string) =>
    /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(s.replace(/^(?:\s*--[^\n]*\n)+/, "").trim());
  for (const s of statements) if (!isIndex(s)) fresh.exec(`${s};`);
  migrate(fresh);
  for (const s of statements) if (isIndex(s)) fresh.exec(`${s};`);
  db = fresh;
  // Query-planner statistics: the dashboard joins 4-5 tables and SQLite was
  // choosing join orders blind. Run once per version-ish (cheap: seconds on
  // this schema), tracked by a state key so it is not repeated on every boot.
  try {
    const ANALYZE_KEY = "analyze_v2";
    const done = (
      db
        .prepare("SELECT value FROM sync_state WHERE key = ?")
        .get(ANALYZE_KEY) as { value: string } | undefined
    )?.value;
    if (done !== "1") {
      db.exec("ANALYZE");
      db.prepare(
        "INSERT INTO sync_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
      ).run(ANALYZE_KEY);
    }
  } catch (e) {
    console.error("[db] ANALYZE skipped:", e);
  }
  return db;
}

/** Migrations for DBs created before a change (idempotent, cheap once done). */
function migrate(d: DatabaseSync): void {
  // Rename the historical "fr_*" names (the tracker was FR-only at first) to
  // the generic "country_*" ones. Must run before anything referencing them.
  const buCols = d.prepare("PRAGMA table_info(beatmap_user)").all() as { name: string }[];
  if (buCols.some((c) => c.name === "fr_first")) {
    d.exec("ALTER TABLE beatmap_user RENAME COLUMN fr_first TO country_first");
    d.exec("ALTER TABLE beatmap_user RENAME COLUMN fr_checked_at TO country_checked_at");
  }
  // schema.sql has already created the (empty) country_events table at this
  // point, so copy the old rows over WITHOUT their ids (avoids collisions;
  // chronology lives in `at`).
  const hasOldEvents = d
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fr_first_events'")
    .get();
  if (hasOldEvents) {
    d.exec(
      `INSERT INTO country_events (beatmap_id, event, at, score_at, by_user_id, by_username)
       SELECT beatmap_id, event, at, score_at, by_user_id, by_username
       FROM fr_first_events ORDER BY id`
    );
    d.exec("DROP TABLE fr_first_events");
  }
  d.exec(
    `UPDATE OR IGNORE sync_state SET key = 'country_recheck_hours'
     WHERE key = 'fr_recheck_hours'`
  );
  // Columns added after the public release (safe additive ALTERs).
  const bmCols = d.prepare("PRAGMA table_info(beatmaps)").all() as { name: string }[];
  if (!bmCols.some((c) => c.name === "checksum"))
    d.exec("ALTER TABLE beatmaps ADD COLUMN checksum TEXT");
  const buCols2 = d.prepare("PRAGMA table_info(beatmap_user)").all() as { name: string }[];
  for (const col of ["missing_lazer", "missing_classic", "missing_wither"]) {
    if (!buCols2.some((c) => c.name === col))
      d.exec(`ALTER TABLE beatmap_user ADD COLUMN ${col} INTEGER`);
  }
  // Global leaderboard position tracking (top 1/8/15/25/50/100 counters).
  if (!buCols2.some((c) => c.name === "global_rank"))
    d.exec("ALTER TABLE beatmap_user ADD COLUMN global_rank INTEGER");
  if (!buCols2.some((c) => c.name === "global_checked_at"))
    d.exec("ALTER TABLE beatmap_user ADD COLUMN global_checked_at TEXT");

  // Legacy (ScoreV1) leftovers removed: legacy_total_score fed a best pointer
  // nothing ever read. The raw API payloads keep the value if ever needed.
  const scCols = d.prepare("PRAGMA table_info(scores)").all() as { name: string }[];
  if (scCols.some((c) => c.name === "legacy_total_score"))
    d.exec("ALTER TABLE scores DROP COLUMN legacy_total_score");
  // Playback rate materialized from the mods JSON (see schema.sql). One pass
  // over the existing rows; ROUND(…, 2) kills the float noise lazer stores
  // (0.7000000000000001).
  if (!scCols.some((c) => c.name === "rate"))
    d.exec("ALTER TABLE scores ADD COLUMN rate REAL NOT NULL DEFAULT 1.0");
  // Versioned, because the formula gained the ramp mods after the column
  // shipped: bumping the key recomputes every row. SQL twin of computeRate()
  // in logic/score.ts — the two must stay in sync.
  const RATE_KEY = "rate_backfill";
  const rateDone = (
    d.prepare("SELECT value FROM sync_state WHERE key = ?").get(RATE_KEY) as
      | { value: string }
      | undefined
  )?.value;
  if (rateDone !== "v3") {
    // ROUND(x * 100) / 100 and NOT ROUND(x, 2): the mean of two rates lands on
    // a half-cent (0.61 + 0.60 -> 0.605) and the two roundings disagree there,
    // which would make a re-imported score change bucket.
    d.exec(`
      UPDATE scores SET rate = ROUND(100.0 * COALESCE(
        (SELECT json_extract(je.value, '$.settings.speed_change')
         FROM json_each(scores.mods) je
         WHERE json_extract(je.value, '$.settings.speed_change') IS NOT NULL
         LIMIT 1),
        -- Wind Up / Wind Down / Adaptive Speed: the rate MOVES over the map,
        -- so we store the mean of where it starts and where it ends. Adaptive
        -- Speed has no end (it follows your play): its start is the answer.
        (SELECT (
           COALESCE(json_extract(je.value, '$.settings.initial_rate'), 1.0)
           + COALESCE(
               json_extract(je.value, '$.settings.final_rate'),
               CASE json_extract(je.value, '$.acronym')
                 WHEN 'WU' THEN 1.5
                 WHEN 'WD' THEN 0.75
                 ELSE COALESCE(json_extract(je.value, '$.settings.initial_rate'), 1.0)
               END)
         ) / 2.0
         FROM json_each(scores.mods) je
         WHERE json_extract(je.value, '$.acronym') IN ('WU', 'WD', 'AS')
         LIMIT 1),
        (SELECT CASE
           WHEN json_extract(je.value, '$.acronym') IN ('DT', 'NC') THEN 1.5
           WHEN json_extract(je.value, '$.acronym') IN ('HT', 'DC') THEN 0.75
         END
         FROM json_each(scores.mods) je
         WHERE json_extract(je.value, '$.acronym') IN ('DT', 'NC', 'HT', 'DC')
         LIMIT 1),
        1.0)) / 100.0`);
    d.prepare(
      "INSERT INTO sync_state (key, value) VALUES (?, 'v3') ON CONFLICT(key) DO UPDATE SET value = 'v3'"
    ).run(RATE_KEY);
    console.log("[db] migration: playback rate computed for every stored score");
  }
  // Country sweep history (see schema.sql). Backfilled from the current check
  // date: maps re-queued before this migration look never-checked once, which
  // only means they are swept first — and it fixes itself after that pass.
  if (!buCols2.some((c) => c.name === "country_seen_at")) {
    d.exec("ALTER TABLE beatmap_user ADD COLUMN country_seen_at TEXT");
    // Holding a #1 proves a check established it, even when the date was wiped
    // by a re-queue — and such a map was almost certainly re-queued by the
    // periodic rotation, i.e. checked very recently. Everything still NULL
    // after this really has never been looked at, and goes first.
    d.exec(
      `UPDATE beatmap_user
          SET country_seen_at = COALESCE(country_checked_at,
                CASE WHEN country_first = 1 THEN datetime('now') END)
        WHERE country_checked_at IS NOT NULL OR country_first = 1`
    );
  }
  // Mod multiplier, materialized like `rate`: the column is sorted and shown,
  // and the value is derived from the whole scores table (not from the row),
  // so computing it per query was out of the question. Re-run whenever rows
  // are still missing one — a combination becomes known as soon as a single
  // lazer score uses it.
  if (!scCols.some((c) => c.name === "mod_multiplier"))
    d.exec("ALTER TABLE scores ADD COLUMN mod_multiplier REAL");
  const missingMult = (
    d.prepare("SELECT COUNT(*) c FROM scores WHERE mod_multiplier IS NULL").get() as {
      c: number;
    }
  ).c;
  if (missingMult > 0) {
    const filled = backfillModMultipliers(d);
    console.log(
      `[db] mod multipliers: ${filled} of ${missingMult} scores filled in`
    );
  }
  // "ever checked" flag: distinguishes a re-queued map (global_checked_at
  // reset to NULL) from a never-checked one, so tier transitions found on
  // re-checks are logged while the initial sweep stays silent.
  if (!buCols2.some((c) => c.name === "global_seen"))
    d.exec(
      "ALTER TABLE beatmap_user ADD COLUMN global_seen INTEGER NOT NULL DEFAULT 0"
    );
  // backfill the flag for rows checked before the column existed
  d.exec(
    "UPDATE beatmap_user SET global_seen = 1 WHERE global_seen = 0 AND (global_checked_at IS NOT NULL OR global_rank IS NOT NULL)"
  );
  // best_legacy_score_id sits in a FOREIGN KEY clause: SQLite cannot DROP it
  // directly, the table is rebuilt without it (one-time, fast).
  if (buCols2.some((c) => c.name === "best_legacy_score_id")) {
    d.exec(`
      CREATE TABLE beatmap_user_new (
        beatmap_id INTEGER PRIMARY KEY REFERENCES beatmaps(id),
        fetched_at TEXT,
        played INTEGER NOT NULL DEFAULT 0,
        any_fc INTEGER NOT NULL DEFAULT 0,
        country_first INTEGER NOT NULL DEFAULT 0,
        country_checked_at TEXT,
        country_seen_at TEXT,
        missing_lazer INTEGER,
        missing_classic INTEGER,
        missing_wither INTEGER,
        best_lazer_score_id INTEGER REFERENCES scores(id),
        global_rank INTEGER,
        global_checked_at TEXT,
        global_seen INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO beatmap_user_new
        SELECT beatmap_id, fetched_at, played, any_fc, country_first,
               country_checked_at, country_seen_at, missing_lazer, missing_classic,
               missing_wither, best_lazer_score_id, global_rank,
               global_checked_at, global_seen
        FROM beatmap_user;
      DROP TABLE beatmap_user;
      ALTER TABLE beatmap_user_new RENAME TO beatmap_user;
      CREATE INDEX IF NOT EXISTS idx_bu_played ON beatmap_user(played);
      CREATE INDEX IF NOT EXISTS idx_bu_fetched ON beatmap_user(fetched_at);
    `);
  }

  // Multi-ruleset: beatmap_user gains a `ruleset` column and a composite
  // primary key (beatmap_id, ruleset). Existing rows are all osu!std (0).
  // Rebuild required: SQLite cannot alter a primary key in place.
  const buCols3 = d.prepare("PRAGMA table_info(beatmap_user)").all() as { name: string }[];
  if (!buCols3.some((c) => c.name === "ruleset")) {
    d.exec(`
      CREATE TABLE beatmap_user_mr (
        beatmap_id INTEGER NOT NULL REFERENCES beatmaps(id),
        ruleset INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT,
        played INTEGER NOT NULL DEFAULT 0,
        any_fc INTEGER NOT NULL DEFAULT 0,
        country_first INTEGER NOT NULL DEFAULT 0,
        country_checked_at TEXT,
        country_seen_at TEXT,
        missing_lazer INTEGER,
        missing_classic INTEGER,
        missing_wither INTEGER,
        best_lazer_score_id INTEGER REFERENCES scores(id),
        global_rank INTEGER,
        global_checked_at TEXT,
        global_seen INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (beatmap_id, ruleset)
      );
      INSERT INTO beatmap_user_mr
        SELECT beatmap_id, 0, fetched_at, played, any_fc, country_first,
               country_checked_at, country_seen_at, missing_lazer, missing_classic,
               missing_wither, best_lazer_score_id, global_rank,
               global_checked_at, global_seen
        FROM beatmap_user;
      DROP TABLE beatmap_user;
      ALTER TABLE beatmap_user_mr RENAME TO beatmap_user;
      DROP INDEX IF EXISTS idx_bu_played;
      DROP INDEX IF EXISTS idx_bu_fetched;
      CREATE INDEX IF NOT EXISTS idx_bu_played ON beatmap_user(ruleset, played);
      CREATE INDEX IF NOT EXISTS idx_bu_fetched ON beatmap_user(ruleset, fetched_at);
    `);
  }

  // FC follows leaderboard semantics like every other gauge: the flag now says
  // "my BEST is an FC", not "I FC'd this map once". Renamed rather than
  // re-purposed — `any_fc` holding a best-only value would be a permanent
  // trap, and the rename makes SQLite reject any call site left behind.
  // Runs AFTER the two table rebuilds above, which still speak of any_fc.
  const buCols4 = d.prepare("PRAGMA table_info(beatmap_user)").all() as { name: string }[];
  if (buCols4.some((c) => c.name === "any_fc"))
    d.exec("ALTER TABLE beatmap_user RENAME COLUMN any_fc TO best_fc");
  // Versioned: the rename carries the OLD values over, so every row has to be
  // recomputed once. SQL twin of the UPDATE in refreshBest() — same predicate.
  const FC_KEY = "best_fc_backfill";
  const fcDone = (
    d.prepare("SELECT value FROM sync_state WHERE key = ?").get(FC_KEY) as
      | { value: string }
      | undefined
  )?.value;
  if (fcDone !== "v1") {
    d.exec(
      `UPDATE beatmap_user SET best_fc = COALESCE((
         SELECT CASE WHEN s.fc_state <= 1 THEN 1 ELSE 0 END FROM scores s
         WHERE s.id = beatmap_user.best_lazer_score_id), 0)`
    );
    d.prepare(
      "INSERT INTO sync_state (key, value) VALUES (?, 'v1') ON CONFLICT(key) DO UPDATE SET value = 'v1'"
    ).run(FC_KEY);
    console.log("[db] migration: FC now describes the best score of each map");
  }

  // osu!std is now started explicitly, like the other modes (nothing runs for a
  // mode before its "Start initial sync"). An install that already has a std
  // catalog did that start historically: flag it, or its sync would stop dead.
  // A brand-new database has neither, and stays idle until the user asks.
  const stdStarted = d
    .prepare("SELECT value FROM sync_state WHERE key = 'ruleset_started_0'")
    .get() as { value: string } | undefined;
  if (!stdStarted) {
    const stdRows = (
      d
        .prepare("SELECT COUNT(*) c FROM beatmaps WHERE ruleset = 0")
        .get() as { c: number }
    ).c;
    const imported = d
      .prepare("SELECT 1 FROM sync_state WHERE key = 'catalog_imported_at'")
      .get();
    if (stdRows > 0 || imported)
      d.prepare(
        "INSERT OR REPLACE INTO sync_state(key, value) VALUES('ruleset_started_0', '1')"
      ).run();
  }

  // Multi-ruleset events: gained/lost history rows are tagged with the mode.
  for (const table of ["country_events", "global_events"]) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "ruleset"))
      d.exec(`ALTER TABLE ${table} ADD COLUMN ruleset INTEGER NOT NULL DEFAULT 0`);
  }

  seedDefaultMetrics(d);
  // Startup repair: the immediate country check after a new score can race
  // osu!'s leaderboard update and stamp a false "not #1" (and the deferred
  // confirmation timer does not survive a restart). Re-queue maps whose
  // country check happened within 15 min of one of my scores — the background
  // sweep re-checks them shortly after startup. Cheap and idempotent: a map
  // leaves the window as soon as a check lands 15 min after its last score.
  d.exec(
    `UPDATE beatmap_user SET country_checked_at = NULL
     WHERE country_first = 0 AND played = 1 AND country_checked_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM scores s
         WHERE s.beatmap_id = beatmap_user.beatmap_id
           AND s.ruleset = beatmap_user.ruleset
           AND datetime(s.ended_at) >= datetime(country_checked_at, '-15 minutes'))`
  );
  // Graveyard/WIP diffs attached to ranked sets may have been imported by
  // older versions: we only keep ranked(1)/approved(2)/loved(4).
  d.exec(
    `DELETE FROM beatmap_user WHERE beatmap_id IN
       (SELECT id FROM beatmaps WHERE status NOT IN (1, 2, 4))`
  );
  d.exec("DELETE FROM beatmaps WHERE status NOT IN (1, 2, 4)");
}

/** Equivalent of better-sqlite3's .transaction(). */
export function transaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec("BEGIN");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Rulesets the tracker is following, opted in/out from Settings (each one has
 * real API cost). std can be disabled like the others — its processes stop,
 * the views stay readable. At least one ruleset is always kept (the settings
 * route enforces it; empty state falls back to std).
 */
export function getActiveRulesets(): number[] {
  const raw = getState("active_rulesets") ?? "0";
  const set = new Set(
    raw
      .split(",")
      .map(Number)
      .filter((n) => [0, 1, 2, 3].includes(n))
  );
  if (set.size === 0) set.add(0);
  return [...set].sort();
}

/**
 * Rulesets whose sync has been EXPLICITLY started (per-mode "Start initial
 * sync" button). Activation in Settings only unlocks the views: no catalog
 * enumeration, backfill, polling or sweep runs for a mode before its start.
 * std (0) is always started.
 */
export function getStartedRulesets(): number[] {
  return getActiveRulesets().filter(
    (r) => getState(`ruleset_started_${r}`) === "1"
  );
}

/**
 * `IN (…)` list of ruleset ids, valid even when the list is empty (a fresh
 * install has nothing started until the user asks): `IN ()` is a syntax error,
 * `IN (-1)` matches nothing.
 */
export function sqlIn(rulesets: number[]): string {
  return rulesets.join(",") || "-1";
}

/**
 * Rulesets whose CATALOG must be kept up to date: the started ones plus the
 * convert source (see withConvertSource). Catalog only — scores, polling,
 * sweeps and views stay on getStartedRulesets().
 */
export function catalogRulesets(): number[] {
  return withConvertSource(getStartedRulesets());
}

export function getState(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}
