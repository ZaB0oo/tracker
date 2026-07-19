import { describe, expect, it } from "vitest";
import {
  FC_NONE,
  FC_NO_MISS,
  FC_PERFECT,
  computeFcState,
  displayGrade,
  missingLazerScore,
  pickBest,
} from "../logic/score.js";
import type { SoloScore } from "../osu/types.js";

function score(partial: Partial<SoloScore>): SoloScore {
  return {
    id: Math.floor(Math.random() * 1e9),
    legacy_score_id: null,
    user_id: 1,
    beatmap_id: 1,
    ruleset_id: 0,
    ended_at: "2026-01-01T00:00:00Z",
    rank: "S",
    accuracy: 0.99,
    max_combo: 100,
    total_score: 900_000,
    legacy_total_score: null,
    pp: null,
    is_perfect_combo: false,
    passed: true,
    mods: [],
    statistics: {},
    ...partial,
  };
}

describe("computeFcState", () => {
  it("lazer perfect combo => PERFECT", () => {
    expect(
      computeFcState(score({ is_perfect_combo: true }), 500)
    ).toBe(FC_PERFECT);
  });

  it("stable legacy_perfect => PERFECT even if is_perfect_combo is false", () => {
    expect(
      computeFcState(
        score({ legacy_score_id: 123, legacy_perfect: true, is_perfect_combo: false }),
        500
      )
    ).toBe(FC_PERFECT);
  });

  it("combo == max combo de la map => PERFECT (fallback)", () => {
    expect(computeFcState(score({ max_combo: 500 }), 500)).toBe(FC_PERFECT);
  });

  it("miss => NON_FC", () => {
    expect(
      computeFcState(score({ statistics: { miss: 1 }, max_combo: 499 }), 500)
    ).toBe(FC_NONE);
  });

  it("large_tick_miss (lazer) => NON_FC", () => {
    expect(
      computeFcState(
        score({ statistics: { large_tick_miss: 1 }, max_combo: 480 }),
        500
      )
    ).toBe(FC_NONE);
  });

  it("stable no-miss: missing combo <= number of 100s (slider ends) => FC", () => {
    // 30 missing combo, 30x100: all explained by dropped slider ends
    expect(
      computeFcState(
        score({
          legacy_score_id: 5,
          legacy_perfect: false,
          statistics: { great: 400, ok: 30, miss: 0 },
          max_combo: 470,
        }),
        500
      )
    ).toBe(FC_NO_MISS);
  });

  it("stable no-miss: missing combo > number of 100s => slider break => NON_FC", () => {
    // 250 missing combo but only 3x100: definite break
    expect(
      computeFcState(
        score({
          legacy_score_id: 5,
          legacy_perfect: false,
          statistics: { great: 430, ok: 3, miss: 0 },
          max_combo: 250,
        }),
        500
      )
    ).toBe(FC_NONE);
  });

  it("stable no-miss: edge case missing combo == number of 100s => FC", () => {
    expect(
      computeFcState(
        score({
          legacy_score_id: 5,
          legacy_perfect: false,
          statistics: { great: 450, ok: 10, miss: 0 },
          max_combo: 490,
        }),
        500
      )
    ).toBe(FC_NO_MISS);
  });

  it("lazer no-miss without large_tick_miss => FC even with low combo (slider ends)", () => {
    expect(
      computeFcState(score({ statistics: { miss: 0 }, max_combo: 250 }), 500)
    ).toBe(FC_NO_MISS);
  });

  it("max combo map inconnu : no-miss => FC no-miss", () => {
    expect(
      computeFcState(score({ statistics: { miss: 0 }, max_combo: 300 }), null)
    ).toBe(FC_NO_MISS);
  });
});

describe("pickBest", () => {
  it("separates best lazer and best legacy", () => {
    const a = score({ total_score: 950_000, legacy_total_score: 12_000_000 });
    const b = score({ total_score: 990_000, legacy_total_score: 8_000_000 });
    const { lazer, legacy } = pickBest([a, b]);
    expect(lazer).toBe(b);
    expect(legacy).toBe(a);
  });

  it("score lazer natif: legacy metric = total_score (fallback)", () => {
    const nativeLazer = score({ total_score: 999_000, legacy_total_score: null });
    const oldStable = score({ total_score: 400_000, legacy_total_score: 900_000 });
    const { legacy } = pickBest([nativeLazer, oldStable]);
    expect(legacy).toBe(nativeLazer);
  });

  it("ignore les fails", () => {
    const failed = score({ total_score: 999_999, passed: false });
    const ok = score({ total_score: 100 });
    expect(pickBest([failed, ok]).lazer).toBe(ok);
  });
});

describe("grades & missing", () => {
  it("mappe X/XH vers SS/SSH", () => {
    expect(displayGrade("X")).toBe("SS");
    expect(displayGrade("XH")).toBe("SSH");
    expect(displayGrade("A")).toBe("A");
  });

  it("missing score lazer", () => {
    expect(missingLazerScore(null)).toEqual({ value: 1_000_000, pct: 100 });
    expect(missingLazerScore(900_000).value).toBe(100_000);
    expect(missingLazerScore(1_200_000).value).toBe(0); // mods > 1x, clamp
  });
});
