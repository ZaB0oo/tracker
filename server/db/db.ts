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
