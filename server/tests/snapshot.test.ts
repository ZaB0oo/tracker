import { describe, expect, it } from "vitest";
import {
  replaySnapshot,
  type SnapMap,
  type SnapshotData,
} from "../logic/snapshot.js";
import { CURVE_STEPS } from "../logic/skillCurve.js";

/** A ranked 5.0★ map with every bucket filled; override what the test needs. */
function map(over: Partial<SnapMap> = {}): SnapMap {
  return {
    clear: null, onem: null, rankedDay: "2020-01-01", loved: false,
    sr: 5, q: 50, n: 1000, year: "2020",
    len: 2, combo: 1, ar: 9, od: 8, cs: 4, hp: 5,
    arQ: 90, odQ: 80, csQ: 40, hpQ: 50, len10: 12, comboQ: 20, month: 156,
    ...over,
  };
}

function data(
  maps: SnapMap[],
  over: Partial<SnapshotData> = {}
): SnapshotData {
  const empty = maps.map(() => undefined);
  return { maps, country: [...empty], bests: [...empty], global: [...empty], ...over };
}

type Row = Record<string, number> & { bucket: string };
const status = (p: Record<string, unknown>, name: string): Row =>
  (p.byStatus as Row[]).find((r) => r.bucket === name)!;

describe("replaySnapshot", () => {
  it("replays the best's grade and FC transitions (leaderboard semantics)", () => {
    const d = data([map({ clear: "2021-01-10" })]);
    // S+FC on the 10th, beaten by a higher non-FC A on the 20th
    d.bests[0] = [
      ["2021-01-10", 4, 1, 900_000, 5_000_000, 10],
      ["2021-01-20", 3, 2, 950_000, 6_000_000, 10],
    ];
    const before = replaySnapshot(0, d, "2021-01-05", "sr", CURVE_STEPS);
    const atS = replaySnapshot(0, d, "2021-01-15", "sr", CURVE_STEPS);
    const atA = replaySnapshot(0, d, "2021-02-01", "sr", CURVE_STEPS);
    expect(status(before, "ranked").played).toBe(0);
    expect(status(before, "ranked").total).toBe(1);
    expect(status(atS, "ranked")).toMatchObject({ played: 1, fc: 1, gradeS: 1, nonfc: 0 });
    // the FC and the S DISAPPEAR when a higher non-FC A becomes the best
    expect(status(atA, "ranked")).toMatchObject({ fc: 0, gradeS: 0, gradeA: 1, nonfc: 1 });
  });

  it("splits ranked and loved into their own hero rows", () => {
    const d = data([map(), map({ loved: true, clear: "2021-01-10" })]);
    d.bests[1] = [["2021-01-10", 5, 0, 1_000_000, 1_000_000, 10]];
    const p = replaySnapshot(3, d, "2021-06-01", "sr", CURVE_STEPS);
    expect(status(p, "ranked")).toMatchObject({ total: 1, played: 0 });
    expect(status(p, "loved")).toMatchObject({ total: 1, played: 1, ss: 1, pfc: 1 });
  });

  it("replays global-top tiers, silent takes included", () => {
    const d = data([map({ clear: "2021-01-10" })]);
    d.bests[0] = [["2021-01-10", 4, 1, 900_000, 5_000_000, 10]];
    // rank 5 held from the best (silent take), lost on the 20th
    d.global[0] = [
      ["2021-01-10", 5],
      ["2021-01-20", 0],
    ];
    const held = replaySnapshot(0, d, "2021-01-15", "sr", CURVE_STEPS) as {
      globalTops: Record<string, number>;
    };
    const lost = replaySnapshot(0, d, "2021-02-01", "sr", CURVE_STEPS) as {
      globalTops: Record<string, number>;
    };
    expect(held.globalTops).toMatchObject({ top1: 0, top8: 1, top100: 1, checked: 1 });
    expect(lost.globalTops).toMatchObject({ top8: 0, top100: 0, checked: 0 });
  });

  it("counts the mania 1M from its first date on", () => {
    const d = data([map({ clear: "2021-01-10", onem: "2021-03-01" })]);
    d.bests[0] = [["2021-01-10", 5, 0, 1_000_000, 1_000_000, 10]];
    const before = replaySnapshot(3, d, "2021-02-01", "sr", CURVE_STEPS);
    const after = replaySnapshot(3, d, "2021-03-01", "sr", CURVE_STEPS);
    expect(status(before, "ranked").onem).toBe(0);
    expect(status(after, "ranked").onem).toBe(1);
  });

  it("re-fits the curve on the bests of that date and prices the missing", () => {
    // five 4.0★ maps cleared at 800k => median 800k; a sixth map unplayed
    const maps = Array.from({ length: 6 }, () => map({ q: 40, clear: "2021-01-10" }));
    maps[5].clear = null;
    const d = data(maps);
    for (let i = 0; i < 5; i++)
      d.bests[i] = [["2021-01-10", 4, 1, 800_000, 4_000_000, 10]];
    const p = replaySnapshot(0, d, "2021-06-01", "sr", CURVE_STEPS) as {
      curve: { q: number; predicted: number; total: number; played: number }[];
      missingSums: { missing: number };
    };
    const band = p.curve.find((b) => b.q === 40)!;
    expect(band.predicted).toBe(800_000);
    expect(band).toMatchObject({ total: 6, played: 5 });
    // the unplayed map misses the full median, the others nothing
    expect(p.missingSums.missing).toBe(800_000);
  });

  it("buckets the curve panel along the selected dimension", () => {
    // two maps in different length bands, one of them without an SR
    const d = data([
      map({ clear: "2021-01-10", len10: 6 }),
      map({ q: -1, sr: 0, len10: 30 }),
    ]);
    d.bests[0] = [["2021-01-10", 4, 1, 800_000, 4_000_000, 10]];
    const p = replaySnapshot(0, d, "2021-06-01", "length", 60) as {
      curveDim: string;
      curve: { q: number; total: number; played: number }[];
    };
    expect(p.curveDim).toBe("length");
    expect(p.curve.find((b) => b.q === 6)).toMatchObject({ total: 1, played: 1 });
    // the SR-less map still lands in its own length band, like the live curve
    expect(p.curve.find((b) => b.q === 30)).toMatchObject({ total: 1, played: 0 });
  });
});
