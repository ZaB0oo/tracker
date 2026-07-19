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

/** Additive migrations + cleanups for DBs created before a change. */
function migrate(d: DatabaseSync): void {
  const scoreCols = d.prepare("PRAGMA table_info(scores)").all() as { name: string }[];
  if (!scoreCols.some((c) => c.name === "classic_total_score")) {
    d.exec("ALTER TABLE scores ADD COLUMN classic_total_score INTEGER");
  }
  const setCols = d.prepare("PRAGMA table_info(beatmapsets)").all() as { name: string }[];
  if (!setCols.some((c) => c.name === "download_disabled")) {
    d.exec(
      "ALTER TABLE beatmapsets ADD COLUMN download_disabled INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!setCols.some((c) => c.name === "checked_at")) {
    // direct check date via GET /beatmapsets/{id} (DMCA dump-diff)
    d.exec("ALTER TABLE beatmapsets ADD COLUMN checked_at TEXT");
  }
  // leftovers from the old dump-diff job (removed once the catalog is complete)
  d.exec("DROP TABLE IF EXISTS unresolved_sets");
  // leftovers from the removed goal/near-SS features (replaced by custom metrics)
  d.exec("DROP TABLE IF EXISTS goals");
  for (const [table, col] of [
    ["scores", "goal_eligible"],
    ["scores", "near_ss"],
    ["beatmap_user", "goal_fc"],
    ["beatmap_user", "near_ss"],
  ]) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.some((c) => c.name === col))
      d.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  }
  const frEvCols = d.prepare("PRAGMA table_info(fr_first_events)").all() as { name: string }[];
  if (frEvCols.length > 0 && !frEvCols.some((c) => c.name === "score_at")) {
    // real date of the score/snipe (ended_at), in addition to the detection date
    d.exec("ALTER TABLE fr_first_events ADD COLUMN score_at TEXT");
  }
  const buCols = d.prepare("PRAGMA table_info(beatmap_user)").all() as { name: string }[];
  if (!buCols.some((c) => c.name === "any_fc")) {
    d.exec("ALTER TABLE beatmap_user ADD COLUMN any_fc INTEGER NOT NULL DEFAULT 0");
    d.exec(
      `UPDATE beatmap_user SET any_fc = EXISTS(
         SELECT 1 FROM scores s
         WHERE s.beatmap_id = beatmap_user.beatmap_id
           AND s.passed = 1 AND s.fc_state <= 1)`
    );
  }
  if (!buCols.some((c) => c.name === "fr_first")) {
    d.exec("ALTER TABLE beatmap_user ADD COLUMN fr_first INTEGER NOT NULL DEFAULT 0");
    d.exec("ALTER TABLE beatmap_user ADD COLUMN fr_checked_at TEXT");
  }
  seedDefaultMetrics(d);
  // One-shot repair: older versions stamped fetched_at as soon as a score
  // arrived via POLLING, skipping the map in the backfill (an old best could
  // stay on osu!'s side). We re-queue all maps played since installation so
  // the backfill re-fetches their complete list of scores.
  const healed = d
    .prepare("SELECT value FROM sync_state WHERE key = 'heal_poll_fetched'")
    .get();
  if (!healed) {
    d.exec(
      `UPDATE beatmap_user SET fetched_at = NULL WHERE beatmap_id IN (
         SELECT DISTINCT beatmap_id FROM scores WHERE ended_at >= '2026-07-12')`
    );
    d.prepare(
      "INSERT OR REPLACE INTO sync_state(key, value) VALUES('heal_poll_fetched', '1')"
    ).run();
  }
  // Startup repair: the immediate country check after a new score can race
  // osu!'s leaderboard update and stamp a false "not #1" (and the deferred
  // confirmation timer does not survive a restart). Re-queue maps whose
  // country check happened within 15 min of one of my scores — the background
  // sweep re-checks them shortly after startup. Cheap and idempotent: a map
  // leaves the window as soon as a check lands 15 min after its last score.
  d.exec(
    `UPDATE beatmap_user SET fr_checked_at = NULL
     WHERE fr_first = 0 AND played = 1 AND fr_checked_at IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM scores s
         WHERE s.beatmap_id = beatmap_user.beatmap_id
           AND datetime(s.ended_at) >= datetime(fr_checked_at, '-15 minutes'))`
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
