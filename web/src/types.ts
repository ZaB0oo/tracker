export interface TableRow {
  beatmap_id: number;
  beatmapset_id: number;
  version: string;
  status: number;
  total_length: number | null;
  bpm: number | null;
  cs: number | null;
  ar: number | null;
  od: number | null;
  hp: number | null;
  star_rating: number | null;
  map_max_combo: number | null;
  artist: string;
  title: string;
  creator: string;
  ranked_date: string | null;
  dmca: number;
  score_id: number | null;
  ended_at: string | null;
  grade: string | null;
  accuracy: number | null;
  score_max_combo: number | null;
  pp: number | null;
  mods: string | null;
  mod_multiplier: number | null;
  fc_state: number | null;
  total_score: number | null;
  classic_total_score: number | null;
  score_value: number | null;
  missing_value: number;
  missing_pct: number | null;
  played: number;
  any_fc: number;
  fr_first: number;
}

export interface MapDetail {
  map: {
    id: number;
    beatmapset_id: number;
    version: string;
    status: number;
    total_length: number | null;
    bpm: number | null;
    cs: number | null;
    ar: number | null;
    od: number | null;
    hp: number | null;
    star_rating: number | null;
    max_combo: number | null;
    count_circles: number | null;
    count_sliders: number | null;
    count_spinners: number | null;
    artist: string;
    title: string;
    creator: string;
    ranked_date: string | null;
    dmca: number;
  };
  scores: {
    id: number;
    ended_at: string;
    rank: string;
    accuracy: number;
    max_combo: number;
    total_score: number;
    classic_total_score: number | null;
    pp: number | null;
    mods: string;
    fc_state: number;
    passed: number;
  }[];
  user: {
    played: number;
    any_fc: number;
    fr_first: number;
    fr_checked_at: string | null;
    fetched_at: string | null;
  } | null;
  frEvents: {
    event: string;
    at: string;
    score_at: string | null;
    by_username: string | null;
  }[];
}

export type ScoreMode = "lazer" | "classic";

export interface TableResponse {
  rows: TableRow[];
  total: number;
  mode: ScoreMode;
}

export interface Stats {
  totals: {
    total: number;
    played: number;
    fetched: number;
    ranked_total: number;
    ranked_played: number | null;
    loved_total: number;
    loved_played: number | null;
    fr_firsts: number | null;
    fr_ranked: number | null;
    fr_loved: number | null;
    fc: number | null;
    fc_ranked: number | null;
    fc_loved: number | null;
  };
  scoreSums: {
    lazer: number;
    classic: number;
    wither: number;
    missing: number;
    missingClassic: number;
    missingWither: number;
  };
  grades: { grade: string; c: number }[];
  fc: { fc_state: number; c: number }[];
  bySr: { sr: number; total: number; played: number; fr: number | null; fc: number | null }[];
  byYear: { year: string; total: number; played: number; fr: number | null; fc: number | null }[];
  byAr: Bucket[];
  byOd: Bucket[];
  byHp: Bucket[];
  byCs: Bucket[];
  byLen: Bucket[];
  byCombo: Bucket[];
}

export interface Bucket {
  bucket: number;
  total: number;
  played: number;
  fr: number | null;
  fc: number | null;
}

export interface SkillCurveBucket {
  sr: number;
  predicted: number;
  samples: number;
  inherited: boolean;
  total: number;
  played: number;
  missingClassic: number;
  missingWither: number;
}

export interface SyncStatus {
  phase: string;
  message: string;
  messageAt: string | null;
  busy: string[];
  backfill: { fetched: number; total: number; running: boolean };
  enrich: { done: number; total: number };
  lastPollAt: string | null;
  lastPollNewScores: number;
  queue: { high: number; low: number };
  errors: string[];
  activity: { at: string; source: string; text: string }[];
}

export interface Filters {
  mode: ScoreMode;
  played: "" | "played" | "unplayed";
  q: string;
  grades: string[];
  fcState: string[];
  statuses: string[];
  mods: string;
  frFirst: boolean;
  platform: "" | "lazer" | "stable";
  srMin: string; srMax: string;
  arMin: string; arMax: string;
  odMin: string; odMax: string;
  csMin: string; csMax: string;
  lenMin: string; lenMax: string;
  yearMin: string; yearMax: string;
}

export const DEFAULT_FILTERS: Filters = {
  mode: "classic",
  played: "",
  q: "",
  grades: [],
  fcState: [],
  statuses: [],
  mods: "",
  frFirst: false,
  platform: "",
  srMin: "", srMax: "",
  arMin: "", arMax: "",
  odMin: "", odMax: "",
  csMin: "", csMax: "",
  lenMin: "", lenMax: "",
  yearMin: "", yearMax: "",
};

export const STATUS_LABELS: Record<number, string> = {
  1: "Ranked",
  2: "Approved",
  4: "Loved",
};

export const FC_LABELS: Record<number, string> = {
  0: "PFC",
  1: "FC",
  2: "—",
};
