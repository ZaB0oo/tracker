import type {
  Filters,
  MapDetail,
  SkillCurveBucket,
  Stats,
  SyncStatus,
  TableResponse,
} from "./types";

export interface OverlayStats {
  totalMaps: number;
  clears: number;
  grades: Record<string, number>; // XH, X, SH, S, A, B, C, D
  fc: number;
  country: number;
  rankedClassic: number;
  rankedWither: number;
}

export async function fetchOverlayStats(): Promise<OverlayStats> {
  const res = await fetch("/api/overlay");
  if (!res.ok) throw new Error(`overlay: HTTP ${res.status}`);
  return res.json();
}

export interface OverlayMetric {
  id: number;
  name: string;
  kind: "count" | "ranked_score";
  count: number;
  total: number; // maps matching the metric's map filters (0 for ranked_score)
}

export async function fetchOverlayMetrics(ids: number[]): Promise<{ metrics: OverlayMetric[] }> {
  const res = await fetch(`/api/overlay-metrics?ids=${ids.join(",")}`);
  if (!res.ok) throw new Error(`overlay-metrics: HTTP ${res.status}`);
  return res.json();
}

export async function fetchMapDetail(id: number): Promise<MapDetail> {
  const res = await fetch(`/api/map/${id}`);
  if (!res.ok) throw new Error(`map: HTTP ${res.status}`);
  return res.json();
}

export async function fetchSkillCurve(): Promise<{ buckets: SkillCurveBucket[] }> {
  const res = await fetch("/api/skill-curve");
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
  if (filters.globalTop) p.set("globalTop", filters.globalTop);
  if (filters.metricMissing) p.set("metricMissing", String(filters.metricMissing.id));
  if (filters.platform) p.set("platform", filters.platform);
  for (const k of [
    "srMin", "srMax", "arMin", "arMax", "odMin", "odMax",
    "csMin", "csMax", "lenMin", "lenMax",
    "rankedFrom", "rankedTo", "playedFrom", "playedTo",
  ] as const) {
    if (filters[k] !== "") p.set(k, filters[k]);
  }
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
  fc_state: number;
  pp: number | null;
  beatmap_id: number;
  version: string;
  star_rating: number | null;
  artist: string;
  title: string;
}

export async function fetchClears(
  offset: number,
  limit: number,
  day?: string
): Promise<{ rows: ClearRow[]; total: number }> {
  const dayQ = day ? `&day=${day}` : "";
  const res = await fetch(`/api/clears?offset=${offset}&limit=${limit}${dayQ}`);
  if (!res.ok) throw new Error(`clears: HTTP ${res.status}`);
  return res.json();
}

export interface DailyStats {
  year: number;
  years: { min: number; max: number };
  days: { d: string; c: number }[];
  streak: { current: number; longest: number; best: { d: string; c: number } };
}

export async function fetchDaily(year?: number): Promise<DailyStats> {
  const res = await fetch(`/api/daily${year ? `?year=${year}` : ""}`);
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
}

export async function fetchTimeline(): Promise<{
  tiers: string[];
  points: TimelinePoint[];
}> {
  const res = await fetch("/api/timeline");
  if (!res.ok) throw new Error(`timeline: HTTP ${res.status}`);
  return res.json();
}

export interface SnapshotBucket {
  bucket: string | number;
  total: number;
  played: number;
  fc: number;
  country: number;
}

export interface Snapshot {
  day: string;
  bySr: SnapshotBucket[];
  byYear: SnapshotBucket[];
  byLen: SnapshotBucket[];
  byCombo: SnapshotBucket[];
  byAr: SnapshotBucket[];
  byOd: SnapshotBucket[];
  byCs: SnapshotBucket[];
  byHp: SnapshotBucket[];
}

export async function fetchSnapshot(day: string): Promise<Snapshot> {
  const res = await fetch(`/api/snapshot?day=${day}`);
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
}

/** Whether direct import into osu!lazer is configured on the server. */
export async function fetchLazerImportStatus(): Promise<{ available: boolean }> {
  const res = await fetch("/api/lazer-import/status");
  if (!res.ok) return { available: false };
  return res.json();
}

/** Imports the maps matching the filters straight into osu!lazer (merge mode). */
export async function lazerImport(filters: Filters, name: string): Promise<LazerImportResult> {
  const res = await fetch(
    `/api/lazer-import?${buildTableQuery(filters, [], 0, 1)}&name=${encodeURIComponent(name)}`,
    { method: "POST" }
  );
  const json = (await res.json()) as LazerImportResult & { ok: boolean; error?: string };
  if (!res.ok || !json.ok) throw new Error(json.error ?? `lazer import: HTTP ${res.status}`);
  return json;
}

export async function fetchStats(): Promise<Stats> {
  const res = await fetch("/api/stats");
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
    | "recompute"
    | "rebackfill"
    | "catalog-full?force=1"
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

export interface AuthStatus {
  connected: boolean;
  profile: {
    username: string;
    avatar_url: string;
    country_code?: string;
    stats?: ProfileStats;
  } | null;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status");
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
  artist: string;
  title: string;
}

export async function fetchCountryHistory(
  offset: number,
  limit: number,
  event?: "gained" | "lost"
): Promise<{ rows: CountryEvent[]; total: number }> {
  const p = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (event) p.set("event", event);
  const res = await fetch(`/api/country-history?${p.toString()}`);
  if (!res.ok) throw new Error(`country-history: HTTP ${res.status}`);
  return res.json();
}

// ---------- Custom metrics ----------

export interface Range {
  min: number | null;
  max: number | null;
}
export interface MetricScoreConds {
  fc: "none" | "any" | "pfc";
  minGrade: string | null;
  minScore: number | null;
  minClassic: number | null;
  acc?: Range;
  allowedMods: string[] | null;
  requiredMods: string[] | null;
  counts: {
    n100: Range;
    n50: Range;
    nMiss: Range;
    nSliderEnd: Range;
    imperfections: Range;
  };
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
  ids?: number[] | null;
  query?: string | null;
}
export type MetricBreakdown =
  | "sr" | "year" | "length" | "combo" | "ar" | "od" | "cs" | "hp";

export interface MetricParams {
  kind: "count" | "ranked_score";
  score: MetricScoreConds;
  map: MetricMapConds;
  /** dimension of the per-bucket completion on the card (default sr) */
  breakdown?: MetricBreakdown;
  progressMode: "milestone" | "total";
  step: number;
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

export async function deleteMetric(id: number): Promise<void> {
  const res = await fetch(`/api/metrics/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`metrics: HTTP ${res.status}`);
}

export const DEFAULT_METRIC_PARAMS: MetricParams = {
  kind: "count",
  score: {
    fc: "none",
    minGrade: null,
    minScore: null,
    minClassic: null,
    acc: { min: null, max: null },
    allowedMods: null,
    requiredMods: null,
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
    bpmMin: null, bpmMax: null, statuses: [], country1: false, ids: null,
    query: null,
  },
  breakdown: "sr",
  progressMode: "milestone",
  step: 1000,
  showEvolution: true,
};

export interface DisplayPrefs {
  wither: boolean;
}

export interface Settings {
  apiRpm: number;
  pollIntervalSeconds: number;
  countryRecheckHours: number;
  globalRecheckHours: number;
  display: DisplayPrefs;
  discord: { webhookSet: boolean; bests: boolean };
  oauth: { clientId: string; userId: number; secretSet: boolean };
  info: { port: number };
}

export async function postDiscordTest(): Promise<void> {
  const res = await fetch("/api/settings/discord-test", { method: "POST" });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `discord test: HTTP ${res.status}`);
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
  discord?: { webhookUrl?: string; bests?: boolean };
  clientId?: string | number;
  clientSecret?: string | number;
  userId?: string | number;
}): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`settings: HTTP ${res.status}`);
}
