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
  /** playback rate of the best score (0.5x-2.0x, 1 = nomod speed) */
  rate: number | null;
  fc_state: number | null;
  total_score: number | null;
  classic_total_score: number | null;
  score_value: number | null;
  missing_value: number;
  missing_pct: number | null;
  played: number;
  country_first: number;
  global_rank: number | null;
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
    /** playback rate and mod multiplier of that score */
    rate: number | null;
    mod_multiplier: number | null;
  }[];
  user: {
    played: number;
    /** my BEST score on the map is an FC (leaderboard semantics) */
    best_fc: number;
    country_first: number;
    country_checked_at: string | null;
    fetched_at: string | null;
    global_rank: number | null;
    /** the score that counts on the leaderboard — flagged in the table */
    best_lazer_score_id: number | null;
  } | null;
  countryEvents: {
    event: string;
    at: string;
    score_at: string | null;
    by_username: string | null;
  }[];
}

type ScoreMode = "lazer" | "classic";

/** Which maps of the viewed ruleset to count: its own, the converts, or both. */
export type PoolMode = "all" | "specific" | "converts";

export interface TableResponse {
  rows: TableRow[];
  total: number;
  mode: ScoreMode;
}

export interface Stats {
  oneMillions: number;
  totals: {
    total: number;
    played: number;
    fetched: number;
    ranked_total: number;
    ranked_played: number | null;
    loved_total: number;
    loved_played: number | null;
    country_firsts: number | null;
    country_ranked: number | null;
    country_loved: number | null;
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
  globalTops: {
    top1: number; top8: number; top15: number;
    top25: number; top50: number; top100: number;
    checked: number;
  };
  /** playback-rate histogram of the bests (bucket = rate*10, 5..20) */
  byRate: {
    bucket: number; played: number; fc: number; pfc: number; nonfc: number;
    ss: number; gradeS: number; gradeA: number; gradeB: number;
    gradeC: number; gradeD: number; country: number; onem: number;
    top1: number; top8: number; top15: number;
    top25: number; top50: number; top100: number;
  }[];
  bySr: ({ sr: number } & DistCounts)[];
  byYear: ({ year: string } & DistCounts)[];
  byAr: Bucket[];
  byOd: Bucket[];
  byHp: Bucket[];
  byCs: Bucket[];
  byLen: Bucket[];
  byCombo: Bucket[];
  /** hero rows: the same gauges bucketed by status ("ranked" / "loved") */
  byStatus: ({ bucket: string } & DistCounts)[];
}

/**
 * The optional per-bucket gauges every completion surface carries on top of
 * total/played/fc/country. ONE list — the dist rows, the snapshot buckets and
 * the widgets all iterate it instead of copying the fields by hand.
 */
export const EXTRA_GAUGE_KEYS = [
  "pfc", "nonfc", "ss", "gradeS", "gradeA", "gradeB", "gradeC", "gradeD",
  "onem", "top1", "top8", "top15", "top25", "top50", "top100",
] as const;
export type ExtraGaugeKey = (typeof EXTRA_GAUGE_KEYS)[number];

/** shared per-bucket completion counts (extra gauges may be absent) */
export interface DistCounts
  extends Partial<Record<ExtraGaugeKey, number | null>> {
  total: number;
  played: number;
  country: number | null;
  fc: number | null;
}

export interface Bucket extends DistCounts {
  bucket: number;
}

export interface SkillCurveBucket {
  /** bucket index in the requested dimension (sr: star_rating * 10, ...) */
  q: number;
  predicted: number;
  /** median of the band's own bests, before the fit. null under 5 bests. */
  raw: number | null;
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
  backfillPausedModes: number[];
  backfillPassRuleset: number | null;
  backfill: { fetched: number; total: number; running: boolean };
  enrich: { done: number; total: number };
  lastPollAt: string | null;
  lastPollNewScores: number;
  queue: { high: number; low: number };
  errors: string[];
  activity: { at: string; source: string; text: string }[];
  sweeps: {
    country: boolean;
    countryChecked: number;
    countryPending: number;
    global: boolean;
    globalTracking: boolean;
    globalChecked: number;
    globalPending: number;
  };
  /** all four rulesets: per-mode sync state and backfill progress */
  rulesets: {
    ruleset: number;
    name: string;
    /** enabled in Settings (a disabled mode cannot be started) */
    active: boolean;
    started: boolean;
    backfillPaused: boolean;
    specificTotal: number;
    specificFetched: number;
    convertsTotal: number;
    convertsFetched: number;
  }[];
}

export interface Filters {
  mode: ScoreMode;
  /** viewed ruleset (0 osu, 1 taiko, 2 catch, 3 mania) — set by the header switcher */
  ruleset: number;
  /** map pool for non-std rulesets: converts included by default */
  pool: PoolMode;
  /** mania only: key-count filter ("4", "7", "other"); empty = all */
  keys: string[];
  /** mania only: maps with a perfect 1,000,000 play */
  oneMillion: boolean;
  played: "" | "played" | "unplayed";
  q: string;
  grades: string[];
  fcState: string[];
  statuses: string[];
  mods: string;
  countryFirst: boolean;
  /** my global leaderboard position range (empty = unbounded) */
  globalTopMin: string; globalTopMax: string;
  /** playback rate of the best (lazer 0.5x-2.0x) */
  rateMin: string; rateMax: string;
  /** score of the best AND what is left on the map, both in the unit the
   * Classic / Standardised toggle displays — same unit as the two columns
   * they bound. Sent as classicMin/stdMin by buildTableQuery. */
  scoreMin: string; scoreMax: string;
  missingMin: string; missingMax: string;
  /** mod multiplier of the best */
  multMin: string; multMax: string;
  /** Maps left to do for one or more metrics (union when there are several).
   * `matching` only drives the badge wording (countdown metrics say "to fix"),
   * the direction itself is derived per metric on the server. */
  metricMissing: { ids: number[]; name: string; matching?: boolean } | null;
  platform: "" | "lazer" | "stable";
  srMin: string; srMax: string;
  arMin: string; arMax: string;
  odMin: string; odMax: string;
  hpMin: string; hpMax: string;
  csMin: string; csMax: string;
  lenMin: string; lenMax: string;
  comboMin: string; comboMax: string;
  /** hit counts of the best score, keyed by statistic (see RULESET_HIT_FIELDS).
   * Bounds are strings so an empty box stays empty, like the other ranges. */
  hits: Record<string, { min: string; max: string }>;
  /** full dates YYYY-MM-DD (empty = unbounded) */
  rankedFrom: string; rankedTo: string;
  playedFrom: string; playedTo: string;
}

export const DEFAULT_FILTERS: Filters = {
  mode: "classic",
  ruleset: 0,
  pool: "all",
  keys: [],
  oneMillion: false,
  played: "",
  q: "",
  grades: [],
  fcState: [],
  statuses: [],
  mods: "",
  countryFirst: false,
  globalTopMin: "", globalTopMax: "",
  rateMin: "", rateMax: "",
  scoreMin: "", scoreMax: "",
  missingMin: "", missingMax: "",
  multMin: "", multMax: "",
  metricMissing: null,
  platform: "",
  srMin: "", srMax: "",
  arMin: "", arMax: "",
  odMin: "", odMax: "",
  hpMin: "", hpMax: "",
  csMin: "", csMax: "",
  lenMin: "", lenMax: "",
  comboMin: "", comboMax: "",
  hits: {},
  rankedFrom: "", rankedTo: "",
  playedFrom: "", playedTo: "",
};

/** Canonical grade display order, best to worst (XH/X are the SS ranks). */
export const GRADE_ORDER = ["XH", "X", "SH", "S", "A", "B", "C", "D"];

export const STATUS_LABELS: Record<number, string> = {
  1: "Ranked",
  2: "Approved",
  4: "Loved",
};

export const FC_LABELS: Record<number, string> = {
  0: "PFC",
  1: "FC",
  2: "non-FC",
};

/**
 * Filters coming from outside the current session (saved presets in
 * localStorage): fills in what a version that predates a field would not have.
 */
export function normalizeFilters(f: Filters): Filters {
  const legacy = f.metricMissing as unknown as { id?: number } | null;
  return {
    ...DEFAULT_FILTERS,
    ...f,
    hits: f.hits ?? {},
    metricMissing:
      f.metricMissing == null
        ? null
        : {
            ...f.metricMissing,
            // presets saved when a single metric was the only possibility
            ids: f.metricMissing.ids ?? (legacy?.id != null ? [legacy.id] : []),
          },
  };
}
