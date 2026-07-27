import { describe, expect, it } from "vitest";
import {
  classicFromStandardised,
  classicMax,
  RULESET_CATCH,
  RULESET_MANIA,
  RULESET_OSU,
  RULESET_TAIKO,
  RULESETS,
} from "../logic/rulesets.js";
import { computeFcState, FC_NONE, FC_NO_MISS, FC_PERFECT } from "../logic/score.js";

const score = (over: Record<string, unknown> = {}) => ({
  is_perfect_combo: false,
  legacy_perfect: null,
  statistics: {},
  max_combo: 100,
  legacy_score_id: null,
  ...over,
});

describe("classicFromStandardised (ppy/osu ScoreInfoExtensions)", () => {
  it("osu: (n² × 32.57 + 100000) × std/1M", () => {
    expect(classicMax(RULESET_OSU, 1000)).toBe(Math.round(32.57 * 1e6 + 100000));
    expect(classicFromStandardised(RULESET_OSU, 500_000, 1000)).toBe(
      Math.round((32.57 * 1e6 + 100000) / 2)
    );
  });

  it("taiko: (n × 1109 + 100000) × std/1M", () => {
    expect(classicMax(RULESET_TAIKO, 500)).toBe(500 * 1109 + 100000);
    expect(classicFromStandardised(RULESET_TAIKO, 250_000, 500)).toBe(
      Math.round((500 * 1109 + 100000) / 4)
    );
  });

  it("catch: (std/1M × n)² × 21.62 + std/10 — NON-linear in std", () => {
    expect(classicMax(RULESET_CATCH, 800)).toBe(
      Math.round(800 * 800 * 21.62 + 100_000)
    );
    // half the standardised is NOT half the classic (quadratic term)
    const half = classicFromStandardised(RULESET_CATCH, 500_000, 800);
    expect(half).toBe(Math.round(400 * 400 * 21.62 + 50_000));
    expect(half * 2).not.toBe(classicMax(RULESET_CATCH, 800));
  });

  it("mania: classic IS the standardised score", () => {
    expect(classicFromStandardised(RULESET_MANIA, 934_567, 3000)).toBe(934_567);
    expect(classicMax(RULESET_MANIA, 3000)).toBe(1_000_000);
  });
});

describe("computeFcState per ruleset", () => {
  it("catch: tiny droplet misses (small_tick_miss) never break the combo", () => {
    expect(
      computeFcState(
        score({ statistics: { great: 50, small_tick_miss: 7 }, max_combo: 60 }),
        100,
        RULESET_CATCH
      )
    ).toBe(FC_NO_MISS);
  });

  it("catch: a droplet miss (large_tick_miss) breaks it", () => {
    expect(
      computeFcState(
        score({ statistics: { great: 50, large_tick_miss: 1 }, max_combo: 40 }),
        100,
        RULESET_CATCH
      )
    ).toBe(FC_NONE);
  });

  it("taiko legacy: no miss => FC even with combo below max", () => {
    expect(
      computeFcState(
        score({
          legacy_score_id: 123,
          statistics: { great: 400, ok: 12 },
          max_combo: 380,
        }),
        412,
        RULESET_TAIKO
      )
    ).toBe(FC_NO_MISS);
  });

  it("mania: miss breaks, imperfect judgements do not", () => {
    expect(
      computeFcState(
        score({ statistics: { perfect: 500, good: 3, meh: 1 } }),
        600,
        RULESET_MANIA
      )
    ).toBe(FC_NO_MISS);
    expect(
      computeFcState(
        score({ statistics: { perfect: 500, miss: 1 } }),
        600,
        RULESET_MANIA
      )
    ).toBe(FC_NONE);
  });

  it("explicit combo_break result breaks in any ruleset", () => {
    expect(
      computeFcState(
        score({ statistics: { great: 100, combo_break: 1 } }),
        150,
        RULESET_MANIA
      )
    ).toBe(FC_NONE);
  });

  it("std keeps the legacy slider-end refinement", () => {
    // missing combo fully explained by 100s => FC
    expect(
      computeFcState(
        score({
          legacy_score_id: 5,
          statistics: { great: 300, ok: 4 },
          max_combo: 396,
        }),
        400,
        RULESET_OSU
      )
    ).toBe(FC_NO_MISS);
    // missing combo beyond the 100s => hidden slider break => non-FC
    expect(
      computeFcState(
        score({
          legacy_score_id: 5,
          statistics: { great: 300, ok: 1 },
          max_combo: 390,
        }),
        400,
        RULESET_OSU
      )
    ).toBe(FC_NONE);
  });

  it("full combo reference still wins", () => {
    expect(
      computeFcState(score({ max_combo: 100 }), 100, RULESET_TAIKO)
    ).toBe(FC_PERFECT);
  });
});

describe("ruleset registry", () => {
  it("exposes the API names and per-ruleset hit fields", () => {
    expect(RULESETS[RULESET_CATCH].apiName).toBe("fruits");
    expect(RULESETS[RULESET_MANIA].hitFields.map((f) => f.key)).toContain(
      "perfect"
    );
    expect(RULESETS[RULESET_TAIKO].hitFields.map((f) => f.key)).not.toContain(
      "meh"
    );
  });
});
