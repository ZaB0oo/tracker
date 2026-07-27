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

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = OFF"); // bulk imports, order is not guaranteed
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
  migrate(db);
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
               country_checked_at, missing_lazer, missing_classic,
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
               country_checked_at, missing_lazer, missing_classic,
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
 * Rulesets the tracker is following. osu!std (0) is always active; the others
 * are opted into from Settings (each one has real API cost: catalog
 * enumeration + score backfill of its maps and converts).
 */
export function getActiveRulesets(): number[] {
  const raw = getState("active_rulesets") ?? "0";
  const set = new Set(
    raw
      .split(",")
      .map(Number)
      .filter((n) => [0, 1, 2, 3].includes(n))
  );
  set.add(0);
  return [...set].sort();
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
