/**
 * Per-ruleset rules, sourced from ppy/osu (see file references on each item).
 * The API's `rank`, `accuracy` and `statistics` are stored as-is — this module
 * concentrates everything that must be INTERPRETED per ruleset: hit statistic
 * fields, combo/FC semantics and the classic score conversions.
 *
 * Grade thresholds are documented here for reference/tests only (the rank
 * always comes from the API):
 * - base (osu/taiko/mania): X at 100% acc, S >= 95, A >= 90, B >= 80, C >= 70
 *   [ScoreProcessor.RankFromScore]
 * - taiko: S/X demoted to A when any miss  [TaikoScoreProcessor]
 * - catch: own cutoffs — X = 100%, S >= 98, A >= 94, B >= 90, C >= 85
 *   [CatchScoreProcessor]
 * - mania: S promoted to X when every object is PERFECT or GREAT — an SS does
 *   NOT require 100% accuracy (Perfect = 305 base vs Great = 300)
 *   [ManiaScoreProcessor.RankFromScore]
 */

export const RULESET_OSU = 0;
export const RULESET_TAIKO = 1;
export const RULESET_CATCH = 2;
export const RULESET_MANIA = 3;
export const ALL_RULESETS = [
  RULESET_OSU,
  RULESET_TAIKO,
  RULESET_CATCH,
  RULESET_MANIA,
] as const;
export type RulesetId = (typeof ALL_RULESETS)[number];

/** One hit-statistic field of a score, as exposed to metric filters. */
export interface HitField {
  /** key in the score's `statistics` JSON (osu-web snake_case) */
  key: string;
  /** short label for the UI */
  label: string;
}

export interface RulesetDef {
  id: RulesetId;
  /** API identifier (mode= query params, ruleset fields) */
  apiName: "osu" | "taiko" | "fruits" | "mania";
  /** display name */
  name: string;
  /** hit statistics meaningful for this ruleset, best first */
  hitFields: HitField[];
}

export const RULESETS: Record<RulesetId, RulesetDef> = {
  [RULESET_OSU]: {
    id: RULESET_OSU,
    apiName: "osu",
    name: "osu!",
    hitFields: [
      { key: "great", label: "300s" },
      { key: "ok", label: "100s" },
      { key: "meh", label: "50s" },
      { key: "miss", label: "Misses" },
    ],
  },
  [RULESET_TAIKO]: {
    id: RULESET_TAIKO,
    apiName: "taiko",
    name: "osu!taiko",
    hitFields: [
      { key: "great", label: "Greats" },
      { key: "ok", label: "Goods (150)" },
      { key: "miss", label: "Misses" },
    ],
  },
  [RULESET_CATCH]: {
    id: RULESET_CATCH,
    apiName: "fruits",
    name: "osu!catch",
    hitFields: [
      { key: "great", label: "Fruits" },
      { key: "large_tick_hit", label: "Droplets" },
      { key: "small_tick_hit", label: "Tiny droplets" },
      { key: "small_tick_miss", label: "Tiny droplet misses" },
      { key: "miss", label: "Misses" },
    ],
  },
  [RULESET_MANIA]: {
    id: RULESET_MANIA,
    apiName: "mania",
    name: "osu!mania",
    hitFields: [
      { key: "perfect", label: "Perfects (305)" },
      { key: "great", label: "Greats (300)" },
      { key: "good", label: "Goods (200)" },
      { key: "ok", label: "Oks (100)" },
      { key: "meh", label: "Mehs (50)" },
      { key: "miss", label: "Misses" },
    ],
  },
};

export function rulesetDef(id: number): RulesetDef {
  return RULESETS[(id as RulesetId) in RULESETS ? (id as RulesetId) : RULESET_OSU];
}

/** Short display name: "osu!", "taiko", "catch", "mania". */
export function shortModeName(ruleset: number): string {
  return ruleset === RULESET_OSU
    ? "osu!"
    : rulesetDef(ruleset).name.replace("osu!", "");
}

/** Safe ruleset from a query param (default osu!). */
export function parseRulesetParam(v: unknown): RulesetId {
  const n = Number(v);
  return (ALL_RULESETS as readonly number[]).includes(n) ? (n as RulesetId) : 0;
}

/**
 * Mania key count of a map, matching the lazer ManiaBeatmapConverter exactly:
 * mania-specific = max(1, round(CS)); converts follow the CS/OD/special-object
 * ratio rule. C# Math.Round is banker's rounding (x.5 -> nearest EVEN), hence
 * the bank() expression. This is what mania shows as "Keys" instead of CS —
 * a convert's raw circle size means nothing in that mode.
 */
export function maniaKeysSql(): string {
  const bank = (x: string) =>
    `(CASE WHEN ${x} - CAST(${x} AS INTEGER) = 0.5
      THEN CAST(${x} AS INTEGER) + (CAST(${x} AS INTEGER) % 2)
      ELSE CAST(ROUND(${x}) AS INTEGER) END)`;
  const P = `(CAST(COALESCE(b.count_sliders,0) + COALESCE(b.count_spinners,0) AS REAL)
    / NULLIF(COALESCE(b.count_circles,0) + COALESCE(b.count_sliders,0) + COALESCE(b.count_spinners,0), 0))`;
  return `(CASE
    WHEN b.ruleset = 3 THEN MAX(1, ${bank("b.cs")})
    WHEN ${P} < 0.2 THEN 7
    WHEN ${P} < 0.3 OR ${bank("b.cs")} >= 5 THEN (CASE WHEN ${bank("b.od")} > 5 THEN 7 ELSE 6 END)
    WHEN ${P} > 0.6 THEN (CASE WHEN ${bank("b.od")} > 4 THEN 5 ELSE 4 END)
    ELSE MAX(4, MIN(${bank("b.od")} + 1, 7)) END)`;
}

/**
 * SQL condition (alias b) for the mania key-count filter ("4,7,other"), empty
 * when it does not apply. Shared by every view so the Maps table, the dashboard
 * and the metrics all mean the same thing by "7K".
 */
export function keysWhere(ruleset: number, keys: string | undefined): string {
  if (ruleset !== RULESET_MANIA || !keys) return "";
  const KEYS = maniaKeysSql();
  const or: string[] = [];
  for (const k of keys.split(",")) {
    if (k === "4" || k === "7") or.push(`${KEYS} = ${k}`);
    else if (k === "other") or.push(`${KEYS} NOT IN (4, 7)`);
  }
  return or.length ? `(${or.join(" OR ")})` : "";
}

/** Which maps of a ruleset a view counts. */
export type PoolMode = "all" | "specific" | "converts";

/**
 * SQL map-pool condition (alias b) for a ruleset view:
 * - "all" (default): the mode's own maps AND the converts (std maps playable in
 *   it) — what official profiles count;
 * - "specific": the mode's own maps only;
 * - "converts": the converts only.
 * osu!std has no converts, so its pool is always its own maps.
 */
/**
 * Status list for the dashboard scope (All / Ranked / Loved) — the single
 * definition of what each scope counts. Use as `b.status IN ${statusIn(scope)}`.
 */
export function statusIn(scope: string | undefined): string {
  return scope === "ranked" ? "(1, 2)" : scope === "loved" ? "(4)" : "(1, 2, 4)";
}

export function poolWhere(ruleset: number, pool: string | undefined): string {
  if (ruleset === 0) return "b.ruleset = 0";
  if (pool === "specific") return `b.ruleset = ${ruleset}`;
  if (pool === "converts") return "b.ruleset = 0";
  return `(b.ruleset = ${ruleset} OR b.ruleset = 0)`;
}

/**
 * The rulesets whose CATALOG is needed to serve these started modes: osu! is
 * added as soon as a non-std mode is started, because a convert IS a std
 * beatmap (poolWhere counts `ruleset = 0` in every non-std pool). Catalog only —
 * scores, polling and views stay on the started modes.
 */
export function withConvertSource(started: number[]): number[] {
  return started.some((r) => r !== RULESET_OSU) && !started.includes(RULESET_OSU)
    ? [RULESET_OSU, ...started]
    : started;
}

/** Ruleset bitmask (1 osu!, 2 taiko, 4 catch, 8 mania) of a ruleset list. */
export function rulesetMask(rulesets: number[]): number {
  return rulesets.reduce((m, r) => m | (1 << r), 0);
}

/** Seed formats, in order of appearance. */
export type SeedVersion =
  /** flat array of ids: no per-mode information at all */
  | 0
  /** { id: bitmask }: which modes the set has diffs in */
  | 1
  /** { v: 2, sets: { id: packed } }: HOW MANY diffs per mode (8 bits each) */
  | 2;

/** Diffs per ruleset [osu!, taiko, catch, mania] promised by a seed entry. */
export function seedCounts(value: number, version: SeedVersion): number[] {
  return [0, 1, 2, 3].map((r) =>
    version === 2 ? (value >> (8 * r)) & 0xff : (value >> r) & 1
  );
}

/** Packs per-ruleset diff counts for the v2 seed (clamped to 255 per mode). */
export function packSeedCounts(counts: number[]): number {
  return counts.reduce(
    (acc, n, r) => acc | (Math.min(n, 255) << (8 * r)),
    0
  );
}

/**
 * Does a seed set need an individual lookup? Counts per ruleset on both sides.
 * A tracked mode holding FEWER diffs than the seed promises is a hole — the
 * v1 bitmask could only say "has at least one diff of that mode", so a set
 * missing 2 of its 5 catch diffs looked complete and was never fetched.
 * Modes we do not track are ignored: no budget spent on them.
 */
export function seedNeedsLookup(
  need: number[],
  have: number[],
  tracked: number[]
): boolean {
  return tracked.some((r) => (have[r] ?? 0) < (need[r] ?? 0));
}

/**
 * Per-mode growth of the map pools between two poolCounts() snapshots — what
 * the "+N diffs" reports must show. An importer's own `newIds` cannot answer
 * it: they count every new row of every ACTIVE mode whatever the pools hold,
 * so a set full of taiko diffs reads "+200" while no started pool moved.
 * `total` only answers "did anything move" (a std diff grows every mode's pool
 * via the converts, so it double-counts on purpose) — display `label`.
 */
export function poolGrowth(
  before: Map<number, number>,
  after: Map<number, number>
): { total: number; label: string } {
  let total = 0;
  const parts: string[] = [];
  for (const [ruleset, count] of after) {
    const delta = count - (before.get(ruleset) ?? 0);
    if (delta <= 0) continue;
    total += delta;
    parts.push(`${rulesetDef(ruleset).name} +${delta}`);
  }
  return { total, label: parts.length ? parts.join(", ") : "no new map" };
}

/**
 * Classic (stable-feel) score from a standardised score.
 * Source: osu.Game/Scoring/Legacy/ScoreInfoExtensions.convertStandardisedToClassic —
 * one formula per ruleset; `objectCount` = the number of BASIC judgements of
 * the map (non-tick, non-bonus max statistics).
 * NB: mania's classic score IS the standardised score (identity).
 */
// objectCount = the map's BASIC judgement count (lazer's maxBasicJudgements):
// std = circles+sliders+spinners; taiko = hits (= max_combo); catch = fruits
// (≈ max_combo, which adds large droplets); mania: unused.
export function classicFromStandardised(
  ruleset: number,
  standardised: number,
  objectCount: number
): number {
  switch (ruleset) {
    case RULESET_OSU:
      return Math.round(
        (objectCount * objectCount * 32.57 + 100000) * (standardised / 1_000_000)
      );
    case RULESET_TAIKO:
      return Math.round(
        (objectCount * 1109 + 100000) * (standardised / 1_000_000)
      );
    case RULESET_CATCH:
      return Math.round(
        Math.pow((standardised / 1_000_000) * objectCount, 2) * 21.62 +
          standardised / 10
      );
    case RULESET_MANIA:
    default:
      return Math.round(standardised);
  }
}

/** Max classic score of a map (standardised = 1M, no mods). */
export function classicMax(ruleset: number, objectCount: number): number {
  return classicFromStandardised(ruleset, 1_000_000, objectCount);
}
