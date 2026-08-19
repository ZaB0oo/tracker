-- osu! Completionist Tracker schema.
-- `ruleset` everywhere so taiko/catch/mania can be added later (0 = osu! standard).

CREATE TABLE IF NOT EXISTS beatmapsets (
  id INTEGER PRIMARY KEY,
  artist TEXT NOT NULL DEFAULT '',
  artist_unicode TEXT,
  title TEXT NOT NULL DEFAULT '',
  title_unicode TEXT,
  creator TEXT NOT NULL DEFAULT '',
  creator_id INTEGER,
  source TEXT,
  tags TEXT,
  status INTEGER NOT NULL,            -- 1 ranked, 2 approved, 4 loved
  ranked_date TEXT,                   -- ISO 8601
  submitted_date TEXT,
  download_disabled INTEGER NOT NULL DEFAULT 0, -- DMCA / download removed
  checked_at TEXT                     -- direct check via GET /beatmapsets/{id}
);

CREATE TABLE IF NOT EXISTS beatmaps (
  id INTEGER PRIMARY KEY,
  beatmapset_id INTEGER NOT NULL REFERENCES beatmapsets(id),
  ruleset INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '',   -- difficulty name
  status INTEGER NOT NULL,
  total_length INTEGER,               -- seconds
  hit_length INTEGER,
  bpm REAL,
  cs REAL, ar REAL, od REAL, hp REAL,
  star_rating REAL,
  max_combo INTEGER,                  -- via API enrichment pass (missing from dumps)
  checksum TEXT,                      -- .osu MD5 (collection export), via enrichment
  count_circles INTEGER,
  count_sliders INTEGER,
  count_spinners INTEGER,
  last_updated TEXT
);
CREATE INDEX IF NOT EXISTS idx_beatmaps_set ON beatmaps(beatmapset_id);
CREATE INDEX IF NOT EXISTS idx_beatmaps_ruleset_status ON beatmaps(ruleset, status);
CREATE INDEX IF NOT EXISTS idx_beatmaps_sr ON beatmaps(star_rating);

-- All fetched scores (not just the bests): the full history stays queryable.
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY,             -- osu! score id (new format)
  legacy_score_id INTEGER,
  beatmap_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  ruleset INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT NOT NULL,
  rank TEXT NOT NULL,                 -- XH X SH S A B C D
  accuracy REAL NOT NULL,
  max_combo INTEGER NOT NULL,
  total_score INTEGER NOT NULL,       -- lazer standardised
  classic_total_score INTEGER,        -- "classic" lazer display (monotone vs standardised)
  pp REAL,
  is_perfect_combo INTEGER NOT NULL DEFAULT 0,
  legacy_perfect INTEGER,
  fc_state INTEGER NOT NULL,          -- 0 perfect combo, 1 FC no-miss, 2 non-FC
  mods TEXT NOT NULL DEFAULT '[]',    -- JSON [{acronym, settings?}]
  -- playback rate of the score (lazer 0.5x-2.0x): the mod's speed_change
  -- setting, else the mean of initial_rate/final_rate for the ramp mods
  -- (WU/WD/AS), else 1.5 for DT/NC and 0.75 for HT/DC, else 1.0. Materialized:
  -- it is sorted, filtered and grouped on, and digging it out of the mods
  -- JSON per row made every one of those a full scan.
  rate REAL NOT NULL DEFAULT 1.0,
  -- standardised mod multiplier. The API only hands it over on lazer scores
  -- that carry mods, so it is learned from those and applied to the rest
  -- (see logic/modMultiplier.ts). NULL = cannot be known without guessing.
  mod_multiplier REAL,
  statistics TEXT NOT NULL DEFAULT '{}',
  maximum_statistics TEXT,
  passed INTEGER NOT NULL DEFAULT 1,
  raw TEXT                            -- raw API response (audit / future recomputes)
);
CREATE INDEX IF NOT EXISTS idx_scores_beatmap_user ON scores(beatmap_id, user_id);
CREATE INDEX IF NOT EXISTS idx_scores_ended ON scores(ended_at);

-- Per-(beatmap, ruleset) sync state + pointers to the bests (denormalised for
-- fast queries). `ruleset` is the ruleset the map is PLAYED in: for converts
-- (std maps played in taiko/catch/mania) it differs from beatmaps.ruleset.
CREATE TABLE IF NOT EXISTS beatmap_user (
  beatmap_id INTEGER NOT NULL REFERENCES beatmaps(id),
  ruleset INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT,                    -- last backfill of this map (NULL = never fetched)
  played INTEGER NOT NULL DEFAULT 0,
  best_fc INTEGER NOT NULL DEFAULT 0,  -- at least one FC (any mods)
  country_first INTEGER NOT NULL DEFAULT 0, -- I hold the country #1 on the leaderboard
  country_checked_at TEXT,                  -- last country leaderboard check
  -- Same instant, but NEVER cleared by a re-queue: country_checked_at doubles
  -- as the sweep queue (NULL = to check), so resetting it destroys the only
  -- trace of a map having ever been checked. This one keeps that history, and
  -- lets the queue put the never-checked maps first.
  country_seen_at TEXT,
  -- Materialized "realistic missing" (skill-curve prediction minus my best),
  -- refreshed when scores change or the curve is recomputed: keeps /table and
  -- /stats free of the heavy per-row prediction CASE.
  missing_lazer INTEGER,
  missing_classic INTEGER,
  missing_wither INTEGER,
  best_lazer_score_id INTEGER REFERENCES scores(id),
  global_rank INTEGER,                -- my global leaderboard position
  global_checked_at TEXT,             -- last position check (NULL = queued)
  global_seen INTEGER NOT NULL DEFAULT 0, -- ever position-checked (survives re-queues)
  PRIMARY KEY (beatmap_id, ruleset)
);
CREATE INDEX IF NOT EXISTS idx_bu_played ON beatmap_user(ruleset, played);
CREATE INDEX IF NOT EXISTS idx_bu_fetched ON beatmap_user(ruleset, fetched_at);

-- Per-ruleset attributes of CONVERTS (std maps played in taiko/catch/mania):
-- star rating and max combo differ from the original mode. Filled lazily via
-- the attributes endpoint (played converts first, background trickle for the
-- rest) — predictions/SR filters on a convert need this row.
CREATE TABLE IF NOT EXISTS convert_attrs (
  beatmap_id INTEGER NOT NULL,
  ruleset INTEGER NOT NULL,
  star_rating REAL,
  max_combo INTEGER,
  fetched_at TEXT,
  PRIMARY KEY (beatmap_id, ruleset)
);

-- Key/value for global state (checkpoints, cursors, timestamps).
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Custom metrics (milestones + evolution): conditions as JSON.
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  params TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- country #1 history: one row per transition detected by the checks
-- (gained = I take the #1, lost = someone snipes me).
CREATE TABLE IF NOT EXISTS country_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beatmap_id INTEGER NOT NULL,
  ruleset INTEGER NOT NULL DEFAULT 0,
  event TEXT NOT NULL,                -- 'gained' | 'lost'
  at TEXT NOT NULL,                   -- DETECTION date (UTC)
  score_at TEXT,                      -- date of the score that caused the event
  by_user_id INTEGER,                 -- for 'lost': the sniper
  by_username TEXT
);
CREATE INDEX IF NOT EXISTS idx_country_events_at ON country_events(at);

-- global tops history: one row per TIER transition (top 1/8/15/25/50/100)
-- detected by the position checks (immediate check on new bests + periodic
-- re-checks). The initial sweep sets the state silently.
CREATE TABLE IF NOT EXISTS global_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beatmap_id INTEGER NOT NULL,
  ruleset INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,                   -- detection date (UTC)
  old_rank INTEGER,                   -- NULL = was not on the leaderboard
  new_rank INTEGER                    -- NULL = dropped off the leaderboard
);
CREATE INDEX IF NOT EXISTS idx_global_events_at ON global_events(at);

-- star ratings with mods, cached forever (filled lazily via the API
-- "attributes" endpoint the first time a modded score shows up in a list).
CREATE TABLE IF NOT EXISTS modded_sr (
  beatmap_id INTEGER NOT NULL,
  ruleset INTEGER NOT NULL DEFAULT 0,
  mods TEXT NOT NULL,                 -- difficulty mods and their settings, e.g. "DT@s1.35,HR"
  star_rating REAL,
  PRIMARY KEY (beatmap_id, ruleset, mods)
);


-- Official beatmap packs (opt-in sync: Dashboard -> Packs -> import).
CREATE TABLE IF NOT EXISTS packs (
  tag TEXT PRIMARY KEY,             -- "S31", "T12", "FA55"...
  name TEXT NOT NULL,
  type TEXT NOT NULL,               -- standard/featured/tournament/loved/chart/theme/artist
  ruleset INTEGER,                  -- NULL = mode-agnostic (std sets)
  url TEXT,
  date TEXT,
  synced_at TEXT                    -- contents fetched (resumable import)
);
CREATE TABLE IF NOT EXISTS pack_sets (
  tag TEXT NOT NULL,
  beatmapset_id INTEGER NOT NULL,
  PRIMARY KEY (tag, beatmapset_id)
);
CREATE INDEX IF NOT EXISTS idx_pack_sets_set ON pack_sets (beatmapset_id);
CREATE INDEX IF NOT EXISTS idx_beatmaps_set ON beatmaps (beatmapset_id);

-- Read paths that were full scans of the biggest table / of beatmap_user.
-- scores(ruleset, passed, ended_at): the timeline, the daily heatmap, the
-- snapshot index and every metric replay read "my passed scores of a mode in
-- chronological order" — ruleset was not indexed at all.
CREATE INDEX IF NOT EXISTS idx_scores_mode_time
  ON scores (ruleset, passed, ended_at);
-- The sweep queues and their progress counters (polled every few seconds).
CREATE INDEX IF NOT EXISTS idx_bu_country_check
  ON beatmap_user (ruleset, country_checked_at);
CREATE INDEX IF NOT EXISTS idx_bu_global_check
  ON beatmap_user (ruleset, global_checked_at);
-- Default sort of the Maps table (realistic missing, descending).
CREATE INDEX IF NOT EXISTS idx_bu_missing
  ON beatmap_user (ruleset, missing_lazer);
-- Per-map history lookups (map details modal, country/global checks).
CREATE INDEX IF NOT EXISTS idx_country_events_map
  ON country_events (beatmap_id, ruleset);
CREATE INDEX IF NOT EXISTS idx_global_events_map
  ON global_events (beatmap_id, ruleset);
-- Catalog growth by year (timeline) and the "by rank year" distribution.
CREATE INDEX IF NOT EXISTS idx_sets_ranked_date
  ON beatmapsets (ranked_date);
