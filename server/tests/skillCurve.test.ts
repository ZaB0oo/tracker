import { describe, expect, it } from "vitest";
import { fitSkillCurve } from "../logic/skillCurve.js";

/** n identical bests, enough to give the band its own median. */
const band = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("fitSkillCurve", () => {
  it("keeps a band's own median when nothing harder beats it", () => {
    const b = fitSkillCurve(
      new Map([
        [10, band(9, 900_000)],
        [20, band(9, 700_000)],
      ])
    );
    expect(b[10].value).toBe(900_000);
    expect(b[20].value).toBe(700_000);
    expect(b[10].raw).toBe(900_000);
  });

  it("lifts an easy band to the best harder median, never touches the hard one", () => {
    const b = fitSkillCurve(
      new Map([
        [10, band(9, 800_000)], // easy maps, old unmodded scores
        [20, band(9, 1_400_000)], // harder maps, modded bests
        [30, band(9, 1_000_000)],
      ])
    );
    expect(b[10].value).toBe(1_400_000);
    expect(b[10].raw).toBe(800_000); // the gap = score to grind
    expect(b[20].value).toBe(1_400_000);
    expect(b[30].value).toBe(1_000_000); // never pulled down
  });

  it("never predicts below the band's own median", () => {
    const b = fitSkillCurve(
      new Map([
        [10, band(9, 1_500_000)],
        [15, band(101, 1_200_000)],
        [20, band(9, 1_100_000)],
      ])
    );
    for (const q of [10, 15, 20])
      expect(b[q].value).toBeGreaterThanOrEqual(b[q].raw!);
  });

  it("stays non-increasing and carries values across empty bands", () => {
    const b = fitSkillCurve(
      new Map([
        [10, band(9, 1_000_000)],
        [40, band(9, 600_000)],
      ])
    );
    for (let q = 1; q < b.length; q++)
      expect(b[q].value).toBeLessThanOrEqual(b[q - 1].value);
    expect(b[25].value).toBe(1_000_000); // inherited from the left
    expect(b[25].raw).toBeNull();
  });
});
