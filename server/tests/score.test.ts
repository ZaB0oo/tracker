import { describe, expect, it } from "vitest";
import { FC_NONE, FC_NO_MISS, FC_PERFECT, computeFcState, computeRate, srMods, srModsKey } from "../logic/score.js";
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

  it("combo == map max combo => PERFECT (fallback)", () => {
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

  it("unknown map max combo: no-miss => FC no-miss", () => {
    expect(
      computeFcState(score({ statistics: { miss: 0 }, max_combo: 300 }), null)
    ).toBe(FC_NO_MISS);
  });
});

describe("computeRate", () => {
  const r = (mods: unknown[]) => computeRate(mods as Parameters<typeof computeRate>[0]);

  it("no speed mod => 1.0", () => {
    expect(r([])).toBe(1);
    expect(r([{ acronym: "HR" }, { acronym: "HD" }])).toBe(1);
  });

  it("bare DT/NC/HT/DC => their default values", () => {
    expect(r([{ acronym: "DT" }])).toBe(1.5);
    expect(r([{ acronym: "NC" }])).toBe(1.5);
    expect(r([{ acronym: "HT" }])).toBe(0.75);
    expect(r([{ acronym: "DC" }])).toBe(0.75);
  });

  it("speed_change wins, rounded to 2 decimals", () => {
    expect(r([{ acronym: "DT", settings: { speed_change: 1.35 } }])).toBe(1.35);
    // lazer stocke des 0.7000000000000001, qui couperaient un bucket en deux
    expect(r([{ acronym: "HT", settings: { speed_change: 0.7000000000000001 } }])).toBe(0.7);
  });

  // WU/WD/AS n'ont pas de speed_change : le rate BOUGE, on stocke la moyenne
  it("bare Wind Up / Wind Down => average of their default values", () => {
    expect(r([{ acronym: "WU" }])).toBe(1.25); // 1.0 -> 1.5
    expect(r([{ acronym: "WD" }])).toBe(0.88); // 1.0 -> 0.75
  });

  it("Wind Down configured => average of initial/final", () => {
    expect(r([{ acronym: "WD", settings: { initial_rate: 0.51, final_rate: 0.5 } }])).toBe(0.51);
    expect(r([{ acronym: "WD", settings: { initial_rate: 0.61, final_rate: 0.6 } }])).toBe(0.61);
    // un seul des deux réglé : l'autre garde son défaut
    expect(r([{ acronym: "WD", settings: { initial_rate: 0.76 } }])).toBe(0.76);
    expect(r([{ acronym: "WU", settings: { final_rate: 1.4 } }])).toBe(1.2);
  });

  it("Adaptive Speed => its start point (it has no end)", () => {
    expect(r([{ acronym: "AS" }])).toBe(1);
    expect(r([{ acronym: "AS", settings: { initial_rate: 0.8 } }])).toBe(0.8);
  });

  it("ramp mod combined with DT: the ramp decides", () => {
    expect(r([{ acronym: "DT" }, { acronym: "WD", settings: { initial_rate: 0.51, final_rate: 0.5 } }])).toBe(0.51);
  });
});

describe("srMods / srModsKey", () => {
  const j = (v: unknown) => JSON.stringify(v);

  it("keeps only the mods that move the star rating", () => {
    const mods = srMods(j([{ acronym: "CL" }, { acronym: "DT" }, { acronym: "SD" }, { acronym: "HD" }]));
    expect(mods.map((m) => m.acronym)).toEqual(["DT", "HD"]);
  });

  it("carries the rate setting instead of dropping it", () => {
    const mods = srMods(j([{ acronym: "DT", settings: { speed_change: 1.35 } }]));
    expect(mods).toEqual([{ acronym: "DT", settings: { speed_change: 1.35 } }]);
  });

  it("gives two rates of the same mod two different keys", () => {
    const a = srModsKey(srMods(j([{ acronym: "DT", settings: { speed_change: 1.35 } }])));
    const b = srModsKey(srMods(j([{ acronym: "DT", settings: { speed_change: 1.5 } }])));
    const plain = srModsKey(srMods(j([{ acronym: "DT" }])));
    expect(a).not.toBe(b);
    expect(a).not.toBe(plain);
  });

  it("keys one combination the same way whatever the mod order", () => {
    const a = srModsKey(srMods(j([{ acronym: "HR" }, { acronym: "DT" }])));
    const b = srModsKey(srMods(j([{ acronym: "DT" }, { acronym: "HR" }])));
    expect(a).toBe(b);
    expect(a).toBe("DT,HR");
  });

  it("keys the ramps by their own settings", () => {
    const k = srModsKey(srMods(j([{ acronym: "WU", settings: { initial_rate: 1, final_rate: 1.4 } }])));
    expect(k).toBe("WU@i1/f1.4");
  });

  it("keeps DA and keys its overrides", () => {
    const a = srModsKey(srMods(j([{ acronym: "DA", settings: { circle_size: 4 } }])));
    const b = srModsKey(srMods(j([{ acronym: "DA", settings: { circle_size: 5 } }])));
    const plain = srModsKey(srMods(j([{ acronym: "DA" }])));
    expect(a).not.toBe(b);
    expect(a).not.toBe(plain);
  });

  it("keeps the mania key-count mods", () => {
    const mods = srMods(j([{ acronym: "4K" }, { acronym: "CL" }]));
    expect(mods.map((m) => m.acronym)).toEqual(["4K"]);
  });

  it("survives a corrupt mods column", () => {
    expect(srMods("not json")).toEqual([]);
    expect(srMods(j({ acronym: "DT" }))).toEqual([]);
  });
});
