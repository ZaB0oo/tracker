import { describe, expect, it } from "vitest";
import { witherScore, witherSql } from "../logic/wither.js";

describe("witherScore", () => {
  it("full standardised score on a known map size", () => {
    // x = 1 => n² × 36.49 + n × 2095 + std × 0.1
    expect(witherScore(1_000_000, 100)).toBe(
      Math.round(36.49 * 100 * 100 + 2095 * 100 + 100_000)
    );
  });

  it("zero is zero", () => {
    expect(witherScore(0, 500)).toBe(0);
  });

  it("is monotone in the standardised score on a given map", () => {
    let prev = -1;
    for (const std of [0, 100_000, 500_000, 800_000, 950_000, 1_000_000, 1_400_000]) {
      const w = witherScore(std, 750);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it("the SQL twin carries the same constants and both operands", () => {
    const sql = witherSql("s.total_score", "N");
    for (const frag of ["1.62", "36.49", "2095.0", "s.total_score", "N"])
      expect(sql).toContain(frag);
  });
});
