import type { DatabaseSync } from "node:sqlite";

/**
 * Standardised mod multiplier of a score.
 *
 * The API gives it away for free as `total_score_without_mods` — but only on
 * lazer scores that actually carry mods. It is missing on no-mod scores
 * (nothing to divide by) and on scores converted from stable, which is most of
 * a long-time player's history: 43k of 91k bests here.
 *
 * Rather than hardcode ppy's multiplier table (which drifts, and which we would
 * have to keep in sync), the values are LEARNED from the scores that do carry
 * the field. Two levels:
 *  1. the exact mod combination — settings included, so a DT at 1.35x is not
 *     confused with a DT at 1.5x;
 *  2. failing that, the product of the individual multipliers, which the data
 *     confirms exactly (42 combinations checked, 0 mismatch).
 *
 * A combination whose observed multiplier is NOT constant is dropped from the
 * index: Difficulty Adjust is scored against how far you moved the map's own
 * values, so its multiplier depends on the beatmap, not just on the mods. Same
 * reason the product rule is only applied to mods without settings.
 */

export interface MultiplierIndex {
  /** exact mods JSON (as stored) -> multiplier */
  byCombo: Map<string, number>;
  /** single acronym -> multiplier, for combinations never observed */
  bySingle: Map<string, number>;
}

/** Observed multipliers are ratios of integers: 0.9849974 and 0.9850037 are
 * the same value seen through two different scores. */
const SAME = 0.002;

export function buildMultiplierIndex(db: DatabaseSync): MultiplierIndex {
  const rows = db
    .prepare(
      `SELECT mods,
              MIN(CAST(total_score AS REAL) / json_extract(raw,'$.total_score_without_mods')) lo,
              MAX(CAST(total_score AS REAL) / json_extract(raw,'$.total_score_without_mods')) hi
       FROM scores
       WHERE json_extract(raw,'$.total_score_without_mods') > 0
       GROUP BY mods`
    )
    .all() as { mods: string; lo: number; hi: number }[];

  const byCombo = new Map<string, number>();
  const bySingle = new Map<string, number>();
  for (const r of rows) {
    // not a function of the mods alone (Difficulty Adjust & friends): unknown
    if (!(r.hi - r.lo <= SAME)) continue;
    const value = Math.round(((r.lo + r.hi) / 2) * 10000) / 10000;
    byCombo.set(r.mods, value);
    const mods = parseMods(r.mods);
    if (mods.length === 1 && mods[0].settings == null && mods[0].acronym)
      bySingle.set(mods[0].acronym, value);
  }
  return { byCombo, bySingle };
}

function parseMods(json: string): { acronym?: string; settings?: unknown }[] {
  try {
    const v: unknown = JSON.parse(json || "[]");
    return Array.isArray(v) ? (v as { acronym?: string; settings?: unknown }[]) : [];
  } catch {
    return [];
  }
}

/**
 * Multiplier for a mods JSON, or null when it cannot be known without guessing.
 * `direct` is the value the API allowed us to compute for that very score and
 * always wins.
 */
export function multiplierFor(
  modsJson: string,
  idx: MultiplierIndex,
  direct?: number | null
): number | null {
  if (direct != null && Number.isFinite(direct)) return direct;
  const mods = parseMods(modsJson);
  if (mods.length === 0) return 1; // no mods: 1.00 by definition
  const exact = idx.byCombo.get(modsJson);
  if (exact != null) return exact;
  // product fallback, only when every mod is a plain one with a known value
  let product = 1;
  for (const m of mods) {
    if (m.settings != null || !m.acronym) return null;
    const v = idx.bySingle.get(m.acronym);
    if (v == null) return null;
    product *= v;
  }
  return Math.round(product * 10000) / 10000;
}

/**
 * Fills scores.mod_multiplier. Called once by the migration and again whenever
 * rows are left without one (a combination can become known later, as soon as
 * one lazer score carrying the field uses it).
 */
export function backfillModMultipliers(db: DatabaseSync): number {
  // the value the API hands us, wherever it is available
  db.exec(
    `UPDATE scores
        SET mod_multiplier = ROUND(CAST(total_score AS REAL)
              / json_extract(raw,'$.total_score_without_mods'), 4)
      WHERE mod_multiplier IS NULL
        AND json_extract(raw,'$.total_score_without_mods') > 0`
  );
  const idx = buildMultiplierIndex(db);
  const todo = db
    .prepare(
      "SELECT mods, COUNT(*) n FROM scores WHERE mod_multiplier IS NULL GROUP BY mods"
    )
    .all() as { mods: string; n: number }[];
  const upd = db.prepare(
    "UPDATE scores SET mod_multiplier = ? WHERE mods = ? AND mod_multiplier IS NULL"
  );
  let filled = 0;
  for (const t of todo) {
    const v = multiplierFor(t.mods, idx);
    if (v == null) continue;
    upd.run(v, t.mods);
    filled += t.n;
  }
  return filled;
}
