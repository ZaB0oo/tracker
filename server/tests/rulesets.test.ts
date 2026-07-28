import { describe, expect, it } from "vitest";
import {
  classicFromStandardised,
  classicMax,
  poolGrowth,
  packSeedCounts,
  seedCounts,
  seedNeedsLookup,
  withConvertSource,
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

describe("withConvertSource", () => {
  it("adds osu! as the convert source of any started non-std mode", () => {
    expect(withConvertSource([3])).toEqual([0, 3]);
    expect(withConvertSource([1, 2, 3])).toEqual([0, 1, 2, 3]);
  });

  it("leaves the list alone when osu! is already started, or nothing is", () => {
    expect(withConvertSource([0])).toEqual([0]);
    expect(withConvertSource([0, 3])).toEqual([0, 3]);
    expect(withConvertSource([])).toEqual([]);
  });
});

describe("seed catch-up criterion", () => {
  const OSU = 0, TAIKO = 1, CATCH = 2, MANIA = 3;
  const counts = (o = 0, t = 0, c = 0, m = 0) => [o, t, c, m];
  // the user tracks catch + mania, so std is in as their convert source
  const tracked = [OSU, CATCH, MANIA];

  it("packs and reads back the per-mode diff counts (v2)", () => {
    const packed = packSeedCounts(counts(6, 0, 5, 0));
    expect(seedCounts(packed, 2)).toEqual([6, 0, 5, 0]);
    // clamped at 255 per mode, and a mega-collab does not bleed into the next
    expect(seedCounts(packSeedCounts(counts(300, 2)), 2)).toEqual([255, 2, 0, 0]);
  });

  it("v1 bitmask reads as 'at least one diff' per mode", () => {
    expect(seedCounts(1 | 4, 1)).toEqual([1, 0, 1, 0]);
  });

  it("catches a set holding SOME of a mode's diffs (the v1 blind spot)", () => {
    // seed says 5 catch diffs, we hold 3 => 18 maps like this stayed missing
    expect(seedNeedsLookup(counts(6, 0, 5), counts(6, 0, 3), tracked)).toBe(true);
    // v1 could not see it: "has catch diffs" was true on both sides
    expect(seedNeedsLookup(seedCounts(1 | 4, 1), counts(6, 0, 3), tracked)).toBe(false);
  });

  it("skips modes we do not track", () => {
    // 12 taiko diffs missing, but taiko is not started
    expect(seedNeedsLookup(counts(0, 12), counts(0, 0), tracked)).toBe(false);
  });

  it("leaves a complete set alone, extra local diffs included", () => {
    expect(seedNeedsLookup(counts(6, 0, 5), counts(6, 0, 5), tracked)).toBe(false);
    // newly ranked diffs we already have: never a reason to fetch
    expect(seedNeedsLookup(counts(6), counts(7, 3), tracked)).toBe(false);
  });

  it("catches a set we never stored at all", () => {
    expect(seedNeedsLookup(counts(0, 0, 0, 4), counts(), tracked)).toBe(true);
  });
});

describe("poolGrowth", () => {
  it("reports the per-mode pool delta, ignoring modes that did not move", () => {
    const before = new Map([
      [0, 100],
      [2, 50],
    ]);
    const after = new Map([
      [0, 112],
      [2, 50],
    ]);
    expect(poolGrowth(before, after)).toEqual({ total: 12, label: "osu! +12" });
  });

  it("sums the modes for the gate but names each one", () => {
    const g = poolGrowth(new Map([[1, 10], [3, 5]]), new Map([[1, 13], [3, 6]]));
    expect(g.total).toBe(4);
    expect(g.label).toBe("osu!taiko +3, osu!mania +1");
  });

  it("says so when nothing entered a pool (the old counter said +200)", () => {
    expect(poolGrowth(new Map([[0, 100]]), new Map([[0, 100]]))).toEqual({
      total: 0,
      label: "no new map",
    });
  });

  it("treats a newly started mode (absent from the snapshot) as growth", () => {
    expect(poolGrowth(new Map([[0, 10]]), new Map([[0, 10], [2, 7]])).label).toBe(
      "osu!catch +7"
    );
  });
});
