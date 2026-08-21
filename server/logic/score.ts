import type { SoloScore } from "../osu/types.js";
import { RULESET_OSU } from "./rulesets.js";

/**
 * FC state exposed to the UI:
 *  0 = PERFECT  : perfect combo (no combo point lost, slider ends included)
 *  1 = FC       : no miss or "visual" slider break, but combo < max
 *                 (typically dropped slider ends in lazer)
 *  2 = NON_FC   : at least one miss or a combo break
 *
 * Sources, in decreasing reliability:
 *  - stable/legacy score : `legacy_perfect` (stable's "Perfect" flag)
 *  - lazer score         : `is_perfect_combo`
 *  - fallback            : statistics + map max_combo
 *
 * Combo semantics are UNIVERSAL across rulesets (ppy/osu HitResult.cs): the
 * combo breaks on `miss`, `large_tick_miss` and `combo_break`, and never on
 * `small_tick_miss` (catch tiny droplets, std small slider ticks). Only the
 * std-stable slider-end refinement is ruleset-specific.
 */
export const FC_PERFECT = 0;
export const FC_NO_MISS = 1;
export const FC_NONE = 2;

/**
 * Playback rate of a score (lazer 0.5x-2.0x). The rate mods carry an explicit
 * `speed_change` setting when it was customised; a plain DT/NC is 1.5 and a
 * plain HT/DC is 0.75. Rounded to 2 decimals: lazer stores values like
 * 0.7000000000000001, which would split a bucket in two.
 *
 * Wind Up / Wind Down / Adaptive Speed have no speed_change: the rate MOVES
 * over the map, from `initial_rate` to `final_rate`. There is no true single
 * value, so we store the mean of the two — what was played on average, rather
 * than the peak (a 1.0x -> 1.5x wind up is not a 1.5x clear). Adaptive Speed
 * only announces where it starts, so that is what it gets.
 * Defaults come from ppy/osu (ModWindUp/ModWindDown/ModAdaptiveSpeed).
 */
const RAMP_DEFAULTS: Record<string, { init: number; final: number | null }> = {
  WU: { init: 1, final: 1.5 },
  WD: { init: 1, final: 0.75 },
  // Adaptive Speed follows how you play: only its starting point is known
  AS: { init: 1, final: null },
};

export function computeRate(
  mods: {
    acronym?: string;
    settings?: { speed_change?: number; initial_rate?: number; final_rate?: number };
  }[]
): number {
  const round = (v: number) => Math.round(v * 100) / 100;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  for (const m of mods ?? []) {
    const v = num(m?.settings?.speed_change);
    if (v != null) return round(v);
  }
  for (const m of mods ?? []) {
    const d = m?.acronym ? RAMP_DEFAULTS[m.acronym] : undefined;
    if (d) {
      const init = num(m?.settings?.initial_rate) ?? d.init;
      const final = num(m?.settings?.final_rate) ?? d.final ?? init;
      return round((init + final) / 2);
    }
  }
  for (const m of mods ?? []) {
    if (m?.acronym === "DT" || m?.acronym === "NC") return 1.5;
    if (m?.acronym === "HT" || m?.acronym === "DC") return 0.75;
  }
  return 1;
}

/**
 * Mods that move the star rating (osu! DifficultyAdjustmentMods; HD counts
 * since the 2026 reading rework). The three ramps are here because what they
 * change IS the rate, which is what the difficulty calculator reads. DA
 * overrides CS/AR/OD/HP, and the mania key mods change the convert itself —
 * rosu-pp applies both when they are passed along.
 */
export const SR_MODS = new Set([
  "DT", "NC", "HT", "DC", "HR", "EZ", "FL", "HD", "TD", "WU", "WD", "AS",
  "DA",
  "1K", "2K", "3K", "4K", "5K", "6K", "7K", "8K", "9K", "10K", "DS",
]);

export interface ModRef {
  acronym: string;
  settings?: Record<string, unknown>;
}

/**
 * The difficulty-changing mods of a score, SETTINGS INCLUDED. Asking the API
 * for the attributes of a bare "DT" answers for the default 1.5x, so a rate
 * the player customised came back as a plain double time. Sorted by acronym:
 * one combination, one cache key.
 */
export function srMods(modsJson: string): ModRef[] {
  let arr: ModRef[];
  try {
    arr = JSON.parse(modsJson) as ModRef[];
  } catch {
    return []; // hand-edited row: no mods rather than a throw
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m) => m?.acronym && SR_MODS.has(m.acronym))
    .map((m) => (m.settings ? { acronym: m.acronym, settings: m.settings } : { acronym: m.acronym }))
    .sort((a, b) => a.acronym.localeCompare(b.acronym));
}

/** Settings that change the star rating: the rates, and DA's overrides. */
const SR_SETTINGS = [
  "speed_change", "initial_rate", "final_rate",
  "circle_size", "approach_rate", "drain_rate", "overall_difficulty",
] as const;

/**
 * Cache key of a combination. The rate belongs IN the key: without it a DT at
 * 1.35x and a DT at 1.5x share a row, and the first one fetched answers for
 * both. Same for DA's CS/AR/OD/HP overrides.
 */
export function srModsKey(mods: ModRef[]): string {
  return mods
    .map((m) => {
      const parts = SR_SETTINGS.map((k) => {
        const v = m.settings?.[k];
        return typeof v === "number" && Number.isFinite(v)
          ? `${k[0]}${Math.round(v * 100) / 100}`
          : "";
      }).filter(Boolean);
      return parts.length ? `${m.acronym}@${parts.join("/")}` : m.acronym;
    })
    .join(",");
}

export function computeFcState(
  score: Pick<
    SoloScore,
    "is_perfect_combo" | "legacy_perfect" | "statistics" | "max_combo"
  > & { legacy_score_id?: number | null },
  beatmapMaxCombo: number | null,
  ruleset: number = RULESET_OSU
): number {
  const stats = score.statistics ?? {};
  const misses = stats.miss ?? 0;
  const isLegacy = score.legacy_score_id != null;

  const perfect = isLegacy
    ? score.legacy_perfect ?? score.is_perfect_combo
    : score.is_perfect_combo;
  if (perfect) return FC_PERFECT;
  if (beatmapMaxCombo != null && score.max_combo >= beatmapMaxCombo)
    return FC_PERFECT;

  if (misses > 0) return FC_NONE;

  // No miss. large_tick_miss breaks the combo in every ruleset (std slider
  // ticks/repeats, catch droplets); combo_break is its own explicit result.
  if ((stats.large_tick_miss ?? 0) > 0) return FC_NONE;
  if ((stats.combo_break ?? 0) > 0) return FC_NONE;

  if (isLegacy && ruleset === RULESET_OSU) {
    // Stable std rule: dropping a sliderend gives a 100 and removes exactly
    // 1 combo. So no-miss is an FC iff the missing combo is fully explained
    // by sliderends, i.e. missing_combo <= number of 100s.
    // Beyond that, there was necessarily a slider break => non-FC.
    // (taiko/catch/mania stable have no equivalent: their combo-breaking
    // results are all folded into `miss`/`large_tick_miss` above.)
    if (beatmapMaxCombo == null) return FC_NO_MISS; // no reference
    const missingCombo = beatmapMaxCombo - score.max_combo;
    const count100 = stats.ok ?? 0;
    return missingCombo <= count100 ? FC_NO_MISS : FC_NONE;
  }

  // No combo-breaking result recorded => FC (dropped slider ends / tiny
  // droplets don't break the combo).
  return FC_NO_MISS;
}

