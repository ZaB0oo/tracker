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

/** Safe ruleset from a query param (default osu!). */
export function parseRulesetParam(v: unknown): RulesetId {
  const n = Number(v);
  return (ALL_RULESETS as readonly number[]).includes(n) ? (n as RulesetId) : 0;
}

/**
 * SQL map-pool condition (alias b) for a ruleset view:
 * - specific: only maps native to the ruleset;
 * - all (non-std only): + the converts (std maps playable in that mode).
 */
export function poolWhere(ruleset: number, pool: string | undefined): string {
  if (ruleset === 0 || pool !== "all") return `b.ruleset = ${ruleset}`;
  return `(b.ruleset = ${ruleset} OR b.ruleset = 0)`;
}

/**
 * Classic (stable-feel) score from a standardised score.
 * Source: osu.Game/Scoring/Legacy/ScoreInfoExtensions.convertStandardisedToClassic —
 * one formula per ruleset; `objectCount` = the number of BASIC judgements of
 * the map (non-tick, non-bonus max statistics).
 * NB: mania's classic score IS the standardised score (identity).
 */
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
