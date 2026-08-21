/**
 * Witherscore (proposal ppy/osu#38224):
 *   scaled = min(std/1M, (std/1M)^1.62)
 *   wither = scaled × (n_objects² × 36.49 + n_objects × 2095) + std × 0.1
 * Monotone in standardised on a given map => same best as lazer. std only.
 * Pure module: the JS twin and the SQL builder live side by side, and the
 * parity check can hold them together without loading node:sqlite.
 */
const FULL_BASE = 1_000_000;

/** JS twin of witherSql, for the time machine's replay. */
export function witherScore(standardised: number, nObjects: number): number {
  const x = standardised / FULL_BASE;
  return Math.round(
    Math.min(x, Math.pow(x, 1.62)) *
      (36.49 * nObjects * nObjects + 2095 * nObjects) +
      standardised * 0.1
  );
}

/** SQL twin of witherScore — the two MUST stay in sync. */
export function witherSql(stdExpr: string, nExpr: string): string {
  const x = `(CAST(${stdExpr} AS REAL) / ${FULL_BASE}.0)`;
  return `CAST(ROUND(MIN(${x}, pow(${x}, 1.62)) * (36.49 * ${nExpr} * ${nExpr} + 2095.0 * ${nExpr}) + ${stdExpr} * 0.1) AS INTEGER)`;
}
