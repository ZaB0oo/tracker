import { describe, expect, it } from "vitest";
import { fitSkillCurve } from "../logic/skillCurve.js";

/** n identical bests, enough to give the band its own median. */
const band = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("fitSkillCurve", () => {
  it("every sampled band keeps its own median, rises included", () => {
    const b = fitSkillCurve(
      new Map([
        [10, band(9, 800_000)], // easy maps, old unmodded scores
        [20, band(9, 1_400_000)], // harder maps, modded bests
        [30, band(9, 1_000_000)],
      ])
    );
    expect(b[10].value).toBe(800_000);
    expect(b[20].value).toBe(1_400_000);
    expect(b[30].value).toBe(1_000_000);
    expect(b[20].raw).toBe(1_400_000);
  });

  it("carries the last median across empty bands and below the data", () => {
    const b = fitSkillCurve(
      new Map([
        [10, band(9, 1_000_000)],
        [40, band(9, 600_000)],
      ])
    );
    expect(b[5].value).toBe(1_000_000); // below the data: first median
    expect(b[25].value).toBe(1_000_000); // between: carried from the left
    expect(b[25].raw).toBeNull();
    expect(b[60].value).toBe(600_000); // above: last median
  });

  it("under 5 bests a band has no median of its own", () => {
    const b = fitSkillCurve(
      new Map([
        [10, band(4, 900_000)],
        [20, band(5, 700_000)],
      ])
    );
    expect(b[10].raw).toBeNull();
    expect(b[10].value).toBe(700_000); // only sampled median in the data
    expect(b[20].raw).toBe(700_000);
  });

  it("takes the middle best of a band, not an average", () => {
    const b = fitSkillCurve(new Map([[10, [100, 200, 900_000, 300, 400]]]));
    expect(b[10].value).toBe(300); // sorted: 100 200 300 400 900000
  });
});
