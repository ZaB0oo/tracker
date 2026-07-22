import type { SoloScore } from "../osu/types.js";

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
 *  - fallback            : statistics (miss / large_tick_miss) + map max_combo
 */
export const FC_PERFECT = 0;
export const FC_NO_MISS = 1;
export const FC_NONE = 2;

export function computeFcState(
  score: Pick<
    SoloScore,
    "is_perfect_combo" | "legacy_perfect" | "statistics" | "max_combo"
  > & { legacy_score_id?: number | null },
  beatmapMaxCombo: number | null
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

  // No miss. large_tick_miss (missed tick/repeat in lazer) breaks the combo.
  const largeTickMiss = stats.large_tick_miss ?? 0;
  if (largeTickMiss > 0) return FC_NONE;

  if (isLegacy) {
    // Stable rule: dropping a sliderend gives a 100 and removes exactly
    // 1 combo. So no-miss is an FC iff the missing combo is fully explained
    // by sliderends, i.e. missing_combo <= number of 100s.
    // Beyond that, there was necessarily a slider break => non-FC.
    if (beatmapMaxCombo == null) return FC_NO_MISS; // no reference
    const missingCombo = beatmapMaxCombo - score.max_combo;
    const count100 = stats.ok ?? 0;
    return missingCombo <= count100 ? FC_NO_MISS : FC_NONE;
  }

  // Native lazer no-miss score without large_tick_miss: dropped sliderends
  // don't break the combo there => FC.
  return FC_NO_MISS;
}

/**
 * Best score per metric. We keep TWO bests per map:
 * - "lazer" best  : max(total_score)        (current standardised system)
 * - "legacy" best : max(legacy_total_score) (historical ScoreV1 ranked score)
 * A native lazer score has no legacy_total_score: for the legacy metric we
 * fall back to total_score (that's what the site does in legacy mode =
 * converted values; the point is to stay consistent and documented).
 */
export function legacyMetric(s: Pick<SoloScore, "total_score" | "legacy_total_score">): number {
  return s.legacy_total_score ?? s.total_score;
}
