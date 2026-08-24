import type { ProfileStats } from "./api";

/**
 * "Wither level" — the level rework proposal from ppy/osu#17124 (revised):
 * XP is a composite of profile stats (SS x200, S x100, A x50, ranked
 * score /125k, total score /250k, medals x20k, playtime hours x300) and
 * Total XP Required = 5L^3 + 80L^2 + 225L - 310. Inverted exactly by binary
 * search. Top players land around level 200 on this scale.
 */
export const witherXp = (L: number) => 5 * L ** 3 + 80 * L ** 2 + 225 * L - 310;

export function witherLevel(xpTotal: number): number {
  if (!Number.isFinite(xpTotal) || xpTotal <= 0) return 1;
  let lo = 1;
  let hi = 100_000;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (witherXp(mid) <= xpTotal) lo = mid;
    else hi = mid - 1;
  }
  // fractional part: linear progress towards the next level's requirement
  const base = witherXp(lo);
  const next = witherXp(lo + 1);
  return lo + Math.max(0, Math.min(1, (xpTotal - base) / (next - base)));
}

/**
 * The composite XP itself: grade counts from the tracker's per-map bests,
 * everything else from the osu! profile. Shared by the share card and the
 * dashboard stat strip so the two can never drift apart.
 */
export function witherXpTotal(
  g: (grade: string) => number,
  ps: ProfileStats
): number {
  return (
    (g("XH") + g("X")) * 200 +
    (g("SH") + g("S")) * 100 +
    g("A") * 50 +
    ps.ranked_score / 125_000 +
    ps.total_score / 250_000 +
    ps.medals * 20_000 +
    (ps.play_time / 3600) * 300
  );
}
