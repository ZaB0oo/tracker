import type {
  ExtraGaugeKey,
  Filters,
  PoolMode,
  MapDetail,
  SkillCurveBucket,
  Stats,
  SyncStatus,
  TableResponse,
} from "./types";

/** dashboard-wide status scope */
export type DashScope = "all" | "ranked" | "loved";

export interface OverlayStats {
  totalMaps: number;
  clears: number;
  grades: Record<string, number>; // XH, X, SH, S, A, B, C, D
  fc: number;
  country: number;
  globalTops: {
    top1: number; top8: number; top15: number;
    top25: number; top50: number; top100: number;
  };
  rankedClassic: number;
  rankedWither: number;
  /** last play of THIS ruleset (null if none yet) */
  lastPlay: {
    artist: string;
    title: string;
    version: string;
    rank: string;
    at: string;
  } | null;
}

/** mania key-count filter as a query fragment (empty = every key count). */
const keysQ = (keys: string[]) => (keys.length ? `&keys=${keys.join(",")}` : "");

export async function fetchOverlayStats(
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = []
): Promise<OverlayStats> {
  const res = await fetch(
    `/api/overlay?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}`
  );
  if (!res.ok) throw new Error(`overlay: HTTP ${res.status}`);
  return res.json();
}

export interface OverlayMetric {
  id: number;
  name: string;
  kind: "count" | "ranked_score" | "std_score" | "pp" | "total_pp";
  /** countdown metric: a DECREASE is the progress (colored accordingly) */
  descending?: boolean;
  count: number;
  total: number; // maps matching the metric's map filters (0 for ranked_score/pp)
}

export async function fetchOverlayMetrics(ids: number[]): Promise<{ metrics: OverlayMetric[] }> {
  const res = await fetch(`/api/overlay-metrics?ids=${ids.join(",")}`);
  if (!res.ok) throw new Error(`overlay-metrics: HTTP ${res.status}`);
  return res.json();
}

export async function fetchMapDetail(id: number, ruleset = 0): Promise<MapDetail> {
  const res = await fetch(`/api/map/${id}?ruleset=${ruleset}`);
  if (!res.ok) throw new Error(`map: HTTP ${res.status}`);
  return res.json();
}

/** one all-time record: the map it happened on, its value and its date */
export interface RecordEntry {
  mapId: number;
  /** beatmapset id, for the card's cover background */
  setId: number;
  artist: string;
  title: string;
  diff: string;
  at: string;
  value: number | null;
  /** star records only: acronyms of the SR-affecting mods played */
  mods?: string[];
  /** star records only: playback rate of that play (1 = nomod speed) */
  rate?: number | null;
}

export interface Records {
  topClassic: RecordEntry | null;
  topPp: RecordEntry | null;
  bestFcSr: RecordEntry | null;
  bestSsSr: RecordEntry | null;
  peakCombo: RecordEntry | null;
  oldest: RecordEntry | null;
  averages: {
    acc: number | null;
    sr: number | null;
    len: number | null;
    fc: number;
    clears: number;
    classic: number | null;
  } | null;
  /** pool-wide aggregates over every pass, for the stat strip */
  stats: {
    scores: number;
    /** estimated seconds in-map: SUM(length / rate) over the passes */
    playtime: number | null;
    totalStd: number | null;
    totalClassic: number | null;
    /** nomod length of every cleared map, counted once (seconds) */
    clearTime: number | null;
    /** total runtime of the whole catalog in the pool/scope (seconds) */
    catalogTime: number | null;
    totalPp: number;
    /** official profile weighting: 0.95^i over the bests + bonus pp */
    weightedPp: number;
    /** same weighting from official pp only (no local estimates) */
    weightedPpOfficial: number;
    avgPp: number | null;
  };
}

export async function fetchRecords(
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all",
  at: string | null = null
): Promise<Records> {
  const res = await fetch(
    `/api/records?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}${
      at ? `&day=${at}` : ""
    }`
  );
  if (!res.ok) throw new Error(`records: HTTP ${res.status}`);
  return res.json();
}

/** one play session: consecutive plays less than an hour apart */
export interface SessionEntry {
  start: string;
  end: string;
  sec: number;
  plays: number;
  /** scores of the session that are the map's current best */
  bests: number;
  /** first-ever clears earned in the session */
  newClears: number;
  /** the session's best pp is a local estimate */
  maxPpEst: number;
  classic: number;
  maxPp: number | null;
}

export interface Sessions {
  gapMin: number;
  summary: {
    count: number;
    longestSec: number;
    avgSec: number;
    avgPlays: number;
    /** wall-clock seconds across the sessions (short pauses included) */
    totalSec: number;
    /** real seconds spent in maps (each pass at its rate) */
    playSec: number;
  };
  /** every session, latest first (compact: sort/filter/page client-side) */
  sessions: SessionEntry[];
}

export async function fetchSessions(
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all",
  gapMin = 60
): Promise<Sessions> {
  const res = await fetch(
    `/api/sessions?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}&gap=${gapMin}`
  );
  if (!res.ok) throw new Error(`sessions: HTTP ${res.status}`);
  return res.json();
}

/** one score of a session, map identity included (detail panel) */
export interface SessionScore {
  id: number;
  mapId: number;
  at: string;
  rank: string;
  accuracy: number;
  std: number;
  classic: number | null;
  pp: number | null;
  mods: string;
  rate: number | null;
  fc_state: number;
  passed: number;
  combo: number;
  len: number | null;
  sr: number | null;
  /** star rating of the mods played (null: nomod, or not computed yet) */
  sr_mods: number | null;
  /** the map's max combo (converts: their own), for the combo/max display */
  map_max_combo: number | null;
  artist: string;
  title: string;
  diff: string;
  /** 1 when this score is the map's current best (counts on the leaderboard) */
  best: number;
  /** 1 when pp is a local estimate (unranked mods: the API gave none) */
  pp_est: number;
  /** beatmap status (1 ranked, 2 approved, 4 loved) */
  map_status: number;
  /** best classic score on the map BEFORE this play (null: first clear) */
  prev_best: number | null;
  /** grade of that previous best (null: first clear) */
  prev_grade: string | null;
  /** standardised score of that previous best (null: first clear) */
  prev_best_std: number | null;
  /** 1 when that previous best was an FC (null: first clear) */
  prev_best_fc: number | null;
}

export async function fetchSessionScores(
  start: string,
  end: string,
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all"
): Promise<{ scores: SessionScore[] }> {
  const res = await fetch(
    `/api/sessions/scores?start=${encodeURIComponent(start)}&end=${encodeURIComponent(
      end
    )}&ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}`
  );
  if (!res.ok) throw new Error(`session scores: HTTP ${res.status}`);
  return res.json();
}

/** one best per map: [beatmap_id, stars, accuracy, fc_state, grade 0-7] */
export type ScatterPoint = [number, number, number, number, number];

/** names of a handful of maps (scatter tooltip), keyed by beatmap id */
export async function fetchMapNames(
  ids: number[]
): Promise<{ names: Record<number, string> }> {
  const res = await fetch(`/api/map-names?ids=${ids.join(",")}`);
  if (!res.ok) throw new Error(`map-names: HTTP ${res.status}`);
  return res.json();
}

export async function fetchScatter(
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all",
  day: string | null = null
): Promise<{ points: ScatterPoint[] }> {
  const res = await fetch(
    `/api/scatter?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}${
      day ? `&day=${day}` : ""
    }`
  );
  if (!res.ok) throw new Error(`scatter: HTTP ${res.status}`);
  return res.json();
}

export async function fetchSkillCurve(
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all",
  dim = "sr"
): Promise<{ dim: string; buckets: SkillCurveBucket[] }> {
  const res = await fetch(
    `/api/skill-curve?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}&dim=${dim}`
  );
  if (!res.ok) throw new Error(`skill-curve: HTTP ${res.status}`);
  return res.json();
}

function buildTableQuery(
  filters: Filters,
  sort: { id: string; desc: boolean }[],
  offset: number,
  limit: number
): string {
  const p = new URLSearchParams();
  p.set("mode", filters.mode);
  if (filters.ruleset) p.set("ruleset", String(filters.ruleset));
  if (filters.pool) p.set("pool", filters.pool);
  if (filters.keys.length) p.set("keys", filters.keys.join(","));
  if (filters.oneMillion) p.set("oneMillion", "1");
  p.set("offset", String(offset));
  p.set("limit", String(limit));
  if (sort.length)
    p.set("sort", sort.map((s) => `${s.id}:${s.desc ? "desc" : "asc"}`).join(","));
  if (filters.played) p.set("played", filters.played);
  if (filters.q) p.set("q", filters.q);
  if (filters.grades.length) p.set("grades", filters.grades.join(","));
  if (filters.fcState.length) p.set("fcState", filters.fcState.join(","));
  if (filters.statuses.length) p.set("statuses", filters.statuses.join(","));
  if (filters.mods) p.set("mods", filters.mods);
  if (filters.countryFirst) p.set("countryFirst", "1");
  // one id or several (union). The direction (missing / to fix) is derived
  // per metric server-side, so nothing else needs to be sent.
  if (filters.metricMissing?.ids.length)
    p.set("metricMissing", filters.metricMissing.ids.join(","));
  if (filters.platform) p.set("platform", filters.platform);
  // hit counts: one JSON param, empty bounds dropped so the URL stays short
  // and an all-empty filter never reaches the server
  const hits = Object.fromEntries(
    Object.entries(filters.hits ?? {})
      .map(([k, r]) => [
        k,
        {
          ...(r.min !== "" ? { min: Number(r.min) } : {}),
          ...(r.max !== "" ? { max: Number(r.max) } : {}),
        },
      ])
      .filter(([, r]) => Object.keys(r as object).length > 0)
  );
  if (Object.keys(hits).length) p.set("hits", JSON.stringify(hits));
  for (const k of [
    "srMin", "srMax", "arMin", "arMax", "odMin", "odMax", "hpMin", "hpMax",
    "csMin", "csMax", "lenMin", "lenMax", "comboMin", "comboMax",
    "globalTopMin", "globalTopMax", "rateMin", "rateMax", "ppMin", "ppMax",
    "missingMin", "missingMax", "multMin", "multMax",
    "rankedFrom", "rankedTo", "playedFrom", "playedTo",
  ] as const) {
    if (filters[k] !== "") p.set(k, filters[k]);
  }
  // The score bounds are typed in the displayed unit; the server keeps one
  // param per unit, so the toggle decides which pair gets filled.
  const unit = filters.mode === "classic" ? "classic" : "std";
  if (filters.scoreMin !== "") p.set(`${unit}Min`, filters.scoreMin);
  if (filters.scoreMax !== "") p.set(`${unit}Max`, filters.scoreMax);
  return p.toString();
}

export async function fetchTable(
  filters: Filters,
  sort: { id: string; desc: boolean }[],
  offset: number,
  limit: number
): Promise<TableResponse> {
  const res = await fetch(`/api/table?${buildTableQuery(filters, sort, offset, limit)}`);
  if (!res.ok) throw new Error(`table: HTTP ${res.status}`);
  return res.json();
}

export interface ClearRow {
  id: number;
  ended_at: string;
  rank: string;
  accuracy: number;
  total_score: number;
  classic_total_score: number | null;
  mods: string;
  /** playback rate of the play (null/1 = normal speed) */
  rate: number | null;
  fc_state: number;
  pp: number | null;
  beatmap_id: number;
  version: string;
  star_rating: number | null;
  /** star rating of the mods played (null: nomod, or not computed yet) */
  sr_mods: number | null;
  artist: string;
  title: string;
  /** 1 when this score is the map's current best (counts on the leaderboard) */
  best: number;
}

export async function fetchClears(
  offset: number,
  limit: number,
  day?: string,
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all"
): Promise<{ rows: ClearRow[]; total: number }> {
  const dayQ = day ? `&day=${day}` : "";
  const res = await fetch(
    `/api/clears?offset=${offset}&limit=${limit}&ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}${dayQ}`
  );
  if (!res.ok) throw new Error(`clears: HTTP ${res.status}`);
  return res.json();
}

export interface DailyStats {
  year: number;
  years: { min: number; max: number };
  days: { d: string; c: number }[];
  streak: { current: number; longest: number; best: { d: string; c: number } };
}

export async function fetchDaily(
  year?: number,
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all"
): Promise<DailyStats> {
  const res = await fetch(
    `/api/daily?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}${year ? `&year=${year}` : ""}`
  );
  if (!res.ok) throw new Error(`daily: HTTP ${res.status}`);
  return res.json();
}

export interface TimelinePoint {
  day: string;
  /** catalog size at that date (maps ranked/loved on or before it) */
  total: number;
  totalRanked: number;
  totalLoved: number;
  clears: number;
  clearsRanked: number;
  clearsLoved: number;
  fc: number;
  fcRanked: number;
  fcLoved: number;
  ranked: number;
  country: number;
  countryRanked: number;
  countryLoved: number;
  /** counts per tier, ordered D, C, B, A, S, SH, X, XH */
  grades: number[];
  gradesRanked: number[];
  gradesLoved: number[];
  /** cumulative global-top counts, ordered top 1, 8, 15, 25, 50, 100 */
  topsRanked: number[];
  topsLoved: number[];
  onemRanked: number;
  onemLoved: number;
}

export async function fetchTimeline(
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all"
): Promise<{
  tiers: string[];
  points: TimelinePoint[];
}> {
  const res = await fetch(
    `/api/timeline?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}`
  );
  if (!res.ok) throw new Error(`timeline: HTTP ${res.status}`);
  return res.json();
}

/** the extra gauges follow EXTRA_GAUGE_KEYS; the tops are replayed from the
 * global events (a position with no event is dated at the best score) */
export interface SnapshotBucket
  extends Partial<Record<ExtraGaugeKey, number>> {
  bucket: string | number;
  total: number;
  played: number;
  fc: number;
  country: number;
}

export interface Snapshot {
  day: string;
  /** per-status aggregates for the hero rows (bucket: "ranked" | "loved") */
  byStatus: SnapshotBucket[];
  bySr: SnapshotBucket[];
  byYear: SnapshotBucket[];
  byLen: SnapshotBucket[];
  byCombo: SnapshotBucket[];
  byAr: SnapshotBucket[];
  byOd: SnapshotBucket[];
  byCs: SnapshotBucket[];
  byHp: SnapshotBucket[];
  /** rate of the BEST at that date (bucket = rate * 10, 5..20) */
  byRate: SnapshotBucket[];
  /** FC state of the bests at that date (same shape as Stats.fc) */
  fc: { fc_state: number; c: number }[];
  globalTops: {
    top1: number; top8: number; top15: number;
    top25: number; top50: number; top100: number; checked: number;
  };
  /** ranked score at that date, same three units as the live hero */
  scoreSums: { lazer: number; classic: number; wither: number };
  /** realistic missing at that date, curve re-fitted on the bests of the day */
  missingSums: { missing: number; missingClassic: number; missingWither: number };
  /** the dimension `curve` is bucketed on (echoes the request) */
  curveDim: string;
  /** that day's skill curve, same shape as /skill-curve's buckets */
  curve: SkillCurveBucket[];
}

export async function fetchSnapshot(
  day: string,
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all",
  curveDim = "sr"
): Promise<Snapshot> {
  const res = await fetch(
    `/api/snapshot?day=${day}&ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}&curveDim=${curveDim}`
  );
  if (!res.ok) throw new Error(`snapshot: HTTP ${res.status}`);
  return res.json();
}

/** Download URL for a legacy collection.db built from the current filters. */
export function collectionExportUrl(filters: Filters, name: string): string {
  return `/api/export-collection?${buildTableQuery(filters, [], 0, 1)}&name=${encodeURIComponent(name)}`;
}

export interface LazerImportResult {
  mapCount: number;
  created: number;
  updated: number;
  hashes: number;
  invalid: number;
  /** hashes swapped for the locally-installed version of the same beatmap */
  remapped: number;
  /** maps not installed in lazer (kept; appear once downloaded) */
  notInstalled: number;
}

/** Whether direct import into osu!lazer is configured on the server. */
export interface PackRow {
  tag: string;
  name: string;
  type: string;
  date: string | null;
  total: number;
  played: number;
  fced: number;
}
export interface PacksResponse {
  synced: number;
  pending: number;
  categories: { type: string; packs: PackRow[] }[];
}
export async function fetchPacks(
  ruleset = 0,
  at?: string | null,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all"
): Promise<PacksResponse> {
  const res = await fetch(
    `/api/packs?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}${at ? `&at=${at}` : ""}`
  );
  if (!res.ok) throw new Error(`packs: HTTP ${res.status}`);
  return res.json();
}

export interface PackMapRow {
  id: number;
  artist: string;
  title: string;
  version: string;
  status: number;
  ranked_date: string | null;
  star_rating: number | null;
  played: number;
  grade: string | null;
  fc_state: number | null;
  accuracy: number | null;
}
export interface PackDetail {
  tag: string;
  name: string;
  type: string;
  date: string | null;
  url: string | null;
  /** time-machine day the state was replayed at (null = live) */
  at?: string | null;
  maps: PackMapRow[];
}
export async function fetchPackDetail(
  tag: string,
  ruleset = 0,
  at?: string | null,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all"
): Promise<PackDetail> {
  const res = await fetch(
    `/api/packs/${encodeURIComponent(tag)}?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}${at ? `&at=${at}` : ""}`
  );
  if (!res.ok) throw new Error(`pack: HTTP ${res.status}`);
  return res.json();
}
export async function postPacksImport(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/packs/import", { method: "POST" });
  return res.json();
}

/** Manual import of one beatmapset by id (existing route, backfills right after). */
export async function postImportAny(input: string): Promise<{
  ok: boolean;
  error?: string;
  kind?: string;
  setId?: number;
  newDiffs?: number;
  statuses?: Record<string, number>;
}> {
  const res = await fetch("/api/sync/import-any", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return res.json();
}

/**
 * Catalog verification against a local data.ppy.sh dump file. Not scoped to a
 * ruleset: one archive holds every mode's beatmaps, so a single pass (the
 * decompression is the slow part) checks them all.
 */
export async function postVerifyDump(
  path: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/sync/verify-dump", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.json();
}

export async function fetchLazerImportStatus(): Promise<{ available: boolean }> {
  const res = await fetch("/api/lazer-import/status");
  if (!res.ok) return { available: false };
  return res.json();
}

export interface LazerCollection {
  name: string;
  count: number;
  /** YYYY-MM-DD */
  lastModified: string;
}

/**
 * Collections already in lazer. Never throws: an old importer or a locked
 * database just means "no list", and the import must stay usable.
 */
export async function fetchLazerCollections(): Promise<LazerCollection[]> {
  try {
    const res = await fetch("/api/lazer-import/collections");
    if (!res.ok) return [];
    const json = (await res.json()) as { collections?: LazerCollection[] };
    return json.collections ?? [];
  } catch {
    return [];
  }
}

/**
 * Imports the maps matching the filters straight into osu!lazer. Merge by
 * default; `replace` empties a same-name collection first.
 */
export async function lazerImport(
  filters: Filters,
  name: string,
  replace = false
): Promise<LazerImportResult> {
  const res = await fetch(
    `/api/lazer-import?${buildTableQuery(filters, [], 0, 1)}&name=${encodeURIComponent(name)}${replace ? "&replace=1" : ""}`,
    { method: "POST" }
  );
  const json = (await res.json()) as LazerImportResult & { ok: boolean; error?: string };
  if (!res.ok || !json.ok) throw new Error(json.error ?? `lazer import: HTTP ${res.status}`);
  return json;
}

export async function fetchStats(
  ruleset = 0,
  pool: PoolMode = "all",
  keys: string[] = [],
  scope: DashScope = "all"
): Promise<Stats> {
  const res = await fetch(
    `/api/stats?ruleset=${ruleset}&pool=${pool}${keysQ(keys)}&scope=${scope}`
  );
  if (!res.ok) throw new Error(`stats: HTTP ${res.status}`);
  return res.json();
}

export async function fetchSyncStatus(): Promise<SyncStatus> {
  const res = await fetch("/api/sync/status");
  if (!res.ok) throw new Error(`sync: HTTP ${res.status}`);
  return res.json();
}

export async function postSync(
  action:
    | "start"
    | "pause"
    | "resume"
    | "poll-now"
    | "delta-now"
    | "country-sweep"
    | "country-pause"
    | "global-sweep"
    | "global-pause"
    | "global-recheck-all"
    | "recompute"
    | `start-ruleset/${number}`
    | `backfill-pause/${number}`
    | `backfill-resume/${number}`
    | "refresh-top-pp"
    | "repair-catalog"
    | "rebackfill"
    | "catalog-full?force=1"
    | `catalog-full?force=1&ruleset=${number}`
    | `refresh-top-pp?ruleset=${number}`
    | `global-recheck-all?ruleset=${number}`
    | `rebackfill?ruleset=${number}`
): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/sync/${action}`, { method: "POST" });
  return res.json().catch(() => ({}));
}

export interface ProfileStats {
  play_count: number;
  play_time: number; // seconds
  total_hits: number;
  level: number;
  medals: number;
  global_rank: number | null;
  country_rank: number | null;
  pp: number;
  accuracy: number; // hit accuracy in percent
  ranked_score: number;
  total_score: number;
  followers: number;
  join_date: string;
  supporter: boolean;
}

/** osu!'s Daily Challenge stats, straight from the profile */
export interface DailyChallenge {
  playcount: number;
  daily_current: number;
  daily_best: number;
  weekly_current: number;
  weekly_best: number;
  top10p: number;
  top50p: number;
}

export interface AuthStatus {
  connected: boolean;
  profile: {
    username: string;
    avatar_url: string;
    country_code?: string;
    stats?: ProfileStats;
    daily_challenge?: DailyChallenge | null;
  } | null;
}

/** ruleset: the returned profile stats (pp, ranks, accuracy…) are per mode. */
export async function fetchAuthStatus(ruleset = 0): Promise<AuthStatus> {
  const res = await fetch(`/api/auth/status?ruleset=${ruleset}`);
  if (!res.ok) throw new Error(`auth: HTTP ${res.status}`);
  return res.json();
}

export async function postLogout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

/** Banner + avatar proxied as data URLs (embeddable in the share-card SVG). */
export async function fetchProfileImages(): Promise<{
  avatar: string | null;
  cover: string | null;
}> {
  const res = await fetch("/api/profile-images");
  if (!res.ok) return { avatar: null, cover: null };
  return res.json();
}

export async function postClearErrors(): Promise<void> {
  await fetch("/api/sync/clear-errors", { method: "POST" });
}

export interface CountryEvent {
  id: number;
  event: "gained" | "lost";
  at: string;
  score_at: string | null;
  by_user_id: number | null;
  by_username: string | null;
  beatmap_id: number;
  version: string;
  star_rating: number | null;
  /** star rating of the mods played (null: nomod, or not computed yet) */
  sr_mods: number | null;
  artist: string;
  title: string;
}

export async function fetchCountryHistory(
  offset: number,
  limit: number,
  event?: "gained" | "lost",
  ruleset = 0
): Promise<{ rows: CountryEvent[]; total: number }> {
  const p = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    ruleset: String(ruleset),
  });
  if (event) p.set("event", event);
  const res = await fetch(`/api/country-history?${p.toString()}`);
  if (!res.ok) throw new Error(`country-history: HTTP ${res.status}`);
  return res.json();
}

export interface GlobalEvent {
  id: number;
  at: string;
  old_rank: number | null;
  new_rank: number | null;
  beatmap_id: number;
  version: string;
  star_rating: number | null;
  /** star rating of the mods played (null: nomod, or not computed yet) */
  sr_mods: number | null;
  artist: string;
  title: string;
}

export async function fetchGlobalHistory(
  offset: number,
  limit: number,
  event?: "gained" | "lost",
  ruleset = 0
): Promise<{ rows: GlobalEvent[]; total: number }> {
  const p = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    ruleset: String(ruleset),
  });
  if (event) p.set("event", event);
  const res = await fetch(`/api/global-history?${p.toString()}`);
  if (!res.ok) throw new Error(`global-history: HTTP ${res.status}`);
  return res.json();
}

// ---------- Profile pp ----------

export interface PpTopRow {
  beatmap_id: number;
  pp: number;
  rank: string;
  accuracy: number;
  ended_at: string;
  version: string;
  star_rating: number | null;
  artist: string;
  title: string;
  /** playback rate of the play (1 or null = nomod speed) */
  rate: number | null;
  /** mod acronyms (CL included — it affects pp) */
  mods_list: string[];
  /** star rating with the play's mods (cached; null until fetched) */
  sr_mods: number | null;
}

/** Top pp plays of a pp metric, cumulative up to the end of the period. */
export async function fetchMetricPpTop(
  id: number,
  period: string
): Promise<{ rows: PpTopRow[] }> {
  const res = await fetch(
    `/api/metrics/${id}/pp-top?period=${encodeURIComponent(period)}`
  );
  if (!res.ok) throw new Error(`pp-top: HTTP ${res.status}`);
  return res.json();
}

// ---------- Custom metrics ----------

export interface Range {
  min: number | null;
  max: number | null;
}
export interface MetricScoreConds {
  fc: "none" | "any" | "pfc" | "nonfc";
  minGrade: string | null;
  /** exact grades the score must have (subset of XH X SH S A B C D) */
  grades?: string[] | null;
  minScore: number | null;
  /** upper bound on standardized score */
  maxScore?: number | null;
  minClassic: number | null;
  acc?: Range;
  /** playback rate of the score (lazer 0.5x-2.0x; 1 = nomod speed) */
  rate?: Range;
  /** score pp range (loved/unranked scores have none and never match a bound) */
  pp?: Range;
  allowedMods: string[] | null;
  requiredMods: string[] | null;
  /** must include AT LEAST ONE of these; "NM" also accepts nomod scores */
  anyMods?: string[] | null;
  counts: {
    n100: Range;
    n50: Range;
    nMiss: Range;
    nSliderEnd: Range;
    imperfections: Range;
  };
  /** generic per-statistic bounds (non-std hit results, osu-web keys) */
  hits?: Record<string, Range>;
}
export interface MetricMapConds {
  srMin: number | null; srMax: number | null;
  yearMin: number | null; yearMax: number | null;
  lenMin: number | null; lenMax: number | null;
  arMin: number | null; arMax: number | null;
  odMin: number | null; odMax: number | null;
  csMin: number | null; csMax: number | null;
  hpMin: number | null; hpMax: number | null;
  comboMin: number | null; comboMax: number | null;
  bpmMin: number | null; bpmMax: number | null;
  statuses: number[];
  country1: boolean;
  /** my global leaderboard position range (needs the global tops sweep) */
  globalTopMin?: number | null;
  globalTopMax?: number | null;
  ids?: number[] | null;
  query?: string | null;
}
export type MetricBreakdown =
  | "sr" | "year" | "length" | "combo" | "ar" | "od" | "cs" | "hp";

export interface MetricParams {
  kind: "count" | "ranked_score" | "std_score" | "pp" | "total_pp";
  /** ruleset the metric lives in (default 0 = osu!std) */
  ruleset?: number;
  /** map pool for non-std rulesets (converts included by default) */
  pool?: PoolMode;
  /** mania only: key-count restriction ("4", "7", "other") */
  keys?: string[];
  score: MetricScoreConds;
  map: MetricMapConds;
  /** dimension of the per-bucket completion on the card (default sr) */
  breakdown?: MetricBreakdown;
  /** count kind (countdown): the conditions select the maps still TO FIX;
   * the count heads to 0, with downward milestones */
  descending?: boolean;
  /** countdown only: conditions describe the GOAL — counts the played maps
   * whose best does not meet it yet (exact complement of the goal count) */
  invert?: boolean;
  progressMode: "milestone" | "total";
  step: number;
  /** count metrics: `step` is a PERCENTAGE of the map total, not a map count */
  stepPct?: boolean;
  showEvolution: boolean;
}
export interface Metric {
  id: number;
  name: string;
  params: MetricParams;
  count: number;
  total: number;
  step: number;
  milestones: { threshold: number; at: string }[];
  evolution: { period: string; value: number }[] | null;
  byBucket: { bucket: number | string; value: number; total: number }[];
  /** weighted-pp extras (kind "pp" only) */
  pp?: { bonus: number; scoreCount: number };
}

export async function fetchMetrics(
  granularity: "month" | "day"
): Promise<{ metrics: Metric[] }> {
  const res = await fetch(`/api/metrics?granularity=${granularity}`);
  if (!res.ok) throw new Error(`metrics: HTTP ${res.status}`);
  return res.json();
}

export async function previewMetric(
  params: MetricParams
): Promise<{
  count: number;
  byBucket: { bucket: number | string; value: number; total: number }[];
}> {
  const res = await fetch("/api/metrics/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`preview: HTTP ${res.status}`);
  return res.json();
}

export async function postMetric(payload: {
  name: string;
  params: MetricParams;
}): Promise<void> {
  const res = await fetch("/api/metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error ?? `metrics: HTTP ${res.status}`);
  }
}

export async function putMetric(payload: {
  id: number;
  name: string;
  params: MetricParams;
}): Promise<void> {
  const res = await fetch(`/api/metrics/${payload.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: payload.name, params: payload.params }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(j?.error ?? `metrics: HTTP ${res.status}`);
  }
}

export interface VersionInfo {
  current: string;
  desktop?: boolean;
  update: { version: string; url: string } | null;
}
export async function fetchVersion(): Promise<VersionInfo> {
  const res = await fetch("/api/version");
  if (!res.ok) throw new Error(`version: HTTP ${res.status}`);
  return res.json();
}

/** Persists the display order (full id list, in order). */
export async function reorderMetrics(ids: number[]): Promise<void> {
  const res = await fetch("/api/metrics/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`metrics: HTTP ${res.status}`);
}

export async function deleteMetric(id: number): Promise<void> {
  const res = await fetch(`/api/metrics/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`metrics: HTTP ${res.status}`);
}

/** posts the metric's progress to the Discord webhook (server-side cooldown) */
export async function postMetricDiscord(id: number, conds?: string): Promise<void> {
  const res = await fetch(`/api/metrics/${id}/discord`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conds }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `metrics: HTTP ${res.status}`);
  }
}

export const DEFAULT_METRIC_PARAMS: MetricParams = {
  keys: [],
  kind: "count",
  score: {
    fc: "none",
    minGrade: null,
    grades: null,
    minScore: null,
    maxScore: null,
    minClassic: null,
    acc: { min: null, max: null },
    rate: { min: null, max: null },
    pp: { min: null, max: null },
    allowedMods: null,
    requiredMods: null,
    anyMods: null,
    counts: {
      n100: { min: null, max: null },
      n50: { min: null, max: null },
      nMiss: { min: null, max: null },
      nSliderEnd: { min: null, max: null },
      imperfections: { min: null, max: null },
    },
  },
  map: {
    srMin: null, srMax: null, yearMin: null, yearMax: null,
    lenMin: null, lenMax: null, arMin: null, arMax: null,
    odMin: null, odMax: null, csMin: null, csMax: null,
    hpMin: null, hpMax: null, comboMin: null, comboMax: null,
    bpmMin: null, bpmMax: null, statuses: [], country1: false,
    globalTopMin: null, globalTopMax: null, ids: null,
    query: null,
  },
  breakdown: "sr",
  descending: false,
  progressMode: "milestone",
  step: 1000,
  showEvolution: true,
};

/** Real catalog maxima, used as slider bounds in the metric builder. */
export interface FilterBounds {
  sr: number | null;
  len: number | null;
  combo: number | null;
  bpm: number | null;
  yearMin: number | null;
  globalMax: number | null;
  /** highest pp among my scores */
  pp: number | null;
  /** highest standardized score (mod multipliers push it past 1M) */
  stdMax: number | null;
}
export async function fetchFilterBounds(ruleset = 0): Promise<FilterBounds> {
  const res = await fetch(`/api/metrics/filter-bounds?ruleset=${ruleset}`);
  if (!res.ok) throw new Error(`filter-bounds: HTTP ${res.status}`);
  return res.json();
}

export interface DisplayPrefs {
  wither: boolean;
  /** Performance tile counts locally estimated pp (default on) */
  estPerf: boolean;
}

/** editable layout of the Discord best notifications */
export interface DiscordTemplate {
  title: string;
  body: string;
  cover: boolean;
  footer: boolean;
  author: boolean;
}

/** a random best rendered into template variables + embed chrome */
export interface DiscordSample {
  vars: Record<string, string>;
  cover: string | null;
  footer: string | null;
  author: { name: string; icon_url?: string } | null;
}

export async function fetchDiscordSample(
  ruleset = 0,
  honors = false
): Promise<DiscordSample> {
  const res = await fetch(
    `/api/settings/discord-sample?ruleset=${ruleset}${honors ? "&honors=1" : ""}`
  );
  if (!res.ok) throw new Error(`discord sample: HTTP ${res.status}`);
  return res.json();
}

export interface Settings {
  apiRpm: number;
  /** highest rate the server accepts (60, the documented osu! limit) */
  apiRpmMax: number;
  pollIntervalSeconds: number;
  countryRecheckHours: number;
  globalRecheckHours: number;
  display: DisplayPrefs;
  discord: {
    webhookSet: boolean;
    /** the configured webhooks, URL masked for display (token hidden);
     * their bests/metrics flags are the only notification routing */
    webhooks: { url: string; name: string; bests: boolean; metrics: boolean }[];
    template: DiscordTemplate;
    templateDefault: DiscordTemplate;
  };
  oauth: { clientId: string; userId: number; secretSet: boolean };
  /** path to LazerCollectionImporter.exe ("" = not configured) */
  lazerImporterPath: string;
  /** tracked rulesets (0 osu — always present —, 1 taiko, 2 catch, 3 mania) */
  activeRulesets: number[];
  info: { port: number };
}

/** Uploads a tracker.db; applied at the next app restart (staged swap). */
export async function postImportDb(file: File): Promise<string> {
  const res = await fetch("/api/settings/import-db", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    note?: string;
  };
  if (!res.ok) throw new Error(json.error ?? `import-db: HTTP ${res.status}`);
  return json.note ?? "Import staged: restart the app to apply.";
}

export async function postDiscordTest(): Promise<void> {
  const res = await fetch("/api/settings/discord-test", { method: "POST" });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `discord test: HTTP ${res.status}`);
}

/** posts a random real best through the live notification pipeline */
export async function postDiscordTestBest(ruleset = 0): Promise<void> {
  const res = await fetch("/api/settings/discord-test-best", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ruleset }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `discord test best: HTTP ${res.status}`);
}

export async function fetchSettings(): Promise<Settings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`settings: HTTP ${res.status}`);
  return res.json();
}

export async function postSettings(payload: {
  apiRpm?: number;
  pollIntervalSeconds?: number;
  countryRecheckHours?: number;
  globalRecheckHours?: number;
  display?: Partial<DisplayPrefs>;
  discord?: {
    webhookUrl?: string;
    /** append one webhook to the list (up to 5, deduplicated) */
    webhookAdd?: string;
    /** display name for the webhook being added */
    webhookAddName?: string;
    /** remove the webhook at this index of the configured list */
    webhookRemoveAt?: number;
    /** edit the webhook at this index (only the given fields change) */
    webhookUpdateAt?: number;
    webhookUpdate?: { name?: string; url?: string; bests?: boolean; metrics?: boolean };
    template?: DiscordTemplate | null;
  };
  clientId?: string | number;
  clientSecret?: string | number;
  userId?: string | number;
  lazerImporterPath?: string;
  activeRulesets?: number[];
}): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // surface the server's explanation ("invalid apiRpm (1..60...)"), not
    // just the status code
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `settings: HTTP ${res.status}`);
  }
}
