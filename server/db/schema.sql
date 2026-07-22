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
  legacy_total_score INTEGER,         -- ScoreV1 conversion (NULL for native lazer scores)
  pp REAL,
  is_perfect_combo INTEGER NOT NULL DEFAULT 0,
  legacy_perfect INTEGER,
  fc_state INTEGER NOT NULL,          -- 0 perfect combo, 1 FC no-miss, 2 non-FC
  mods TEXT NOT NULL DEFAULT '[]',    -- JSON [{acronym, settings?}]
  statistics TEXT NOT NULL DEFAULT '{}',
  maximum_statistics TEXT,
  passed INTEGER NOT NULL DEFAULT 1,
  raw TEXT                            -- raw API response (audit / future recomputes)
);
CREATE INDEX IF NOT EXISTS idx_scores_beatmap_user ON scores(beatmap_id, user_id);
CREATE INDEX IF NOT EXISTS idx_scores_ended ON scores(ended_at);

-- Per-beatmap sync state + pointers to the bests (denormalised for fast queries).
CREATE TABLE IF NOT EXISTS beatmap_user (
  beatmap_id INTEGER PRIMARY KEY REFERENCES beatmaps(id),
  fetched_at TEXT,                    -- last backfill of this map (NULL = never fetched)
  played INTEGER NOT NULL DEFAULT 0,
  any_fc INTEGER NOT NULL DEFAULT 0,  -- at least one FC (any mods)
  country_first INTEGER NOT NULL DEFAULT 0, -- I hold the country #1 on the leaderboard
  country_checked_at TEXT,                  -- last country leaderboard check
  -- Materialized "realistic missing" (skill-curve prediction minus my best),
  -- refreshed when scores change or the curve is recomputed: keeps /table and
  -- /stats free of the heavy per-row prediction CASE.
  missing_lazer INTEGER,
  missing_classic INTEGER,
  missing_wither INTEGER,
  best_lazer_score_id INTEGER REFERENCES scores(id),
  best_legacy_score_id INTEGER REFERENCES scores(id)
);
CREATE INDEX IF NOT EXISTS idx_bu_played ON beatmap_user(played);
CREATE INDEX IF NOT EXISTS idx_bu_fetched ON beatmap_user(fetched_at);

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
  event TEXT NOT NULL,                -- 'gained' | 'lost'
  at TEXT NOT NULL,                   -- DETECTION date (UTC)
  score_at TEXT,                      -- date of the score that caused the event
  by_user_id INTEGER,                 -- for 'lost': the sniper
  by_username TEXT
);
CREATE INDEX IF NOT EXISTS idx_country_events_at ON country_events(at);

