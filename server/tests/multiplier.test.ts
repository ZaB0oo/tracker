import { describe, expect, it } from "vitest";
import { multiplierFor, type MultiplierIndex } from "../logic/modMultiplier.js";

const idx = (
  byCombo: [string, number][] = [],
  bySingle: [string, number][] = []
): MultiplierIndex => ({
  byCombo: new Map(byCombo),
  bySingle: new Map(bySingle),
});

const j = (v: unknown) => JSON.stringify(v);

describe("multiplierFor", () => {
  it("the direct API value always wins", () => {
    expect(multiplierFor(j([{ acronym: "DT" }]), idx(), 1.2345)).toBe(1.2345);
  });

  it("no mods = 1.00 by definition", () => {
    expect(multiplierFor("[]", idx())).toBe(1);
    expect(multiplierFor("not json", idx())).toBe(1);
  });

  it("exact combination first, keyed by the stored JSON", () => {
    const mods = j([{ acronym: "DT", settings: { speed_change: 1.35 } }]);
    expect(multiplierFor(mods, idx([[mods, 1.17]]))).toBe(1.17);
  });

  it("falls back to the product of plain single-mod values", () => {
    const mods = j([{ acronym: "DT" }, { acronym: "HD" }]);
    expect(
      multiplierFor(mods, idx([], [["DT", 1.2], ["HD", 1.05]]))
    ).toBe(1.26);
  });

  it("never guesses: unknown single, or any mod with settings", () => {
    expect(
      multiplierFor(j([{ acronym: "DT" }]), idx([], [["HD", 1.05]]))
    ).toBeNull();
    expect(
      multiplierFor(
        j([{ acronym: "DT", settings: { speed_change: 1.35 } }]),
        idx([], [["DT", 1.2]])
      )
    ).toBeNull();
  });
});
