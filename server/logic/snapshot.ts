/**
 * Time-machine snapshot replay. Pure: consumes the per-map index cached by
 * routes/stats.ts (SQL side) and a date, returns the full /api/snapshot
 * payload. On its own so vitest can load it, like skillCurve.ts — modules
 * importing node:sqlite cannot run under the test runner.
 */
import { classicFromStandardised } from "./rulesets.js";
import { CURVE_STEPS, fitSkillCurve } from "./skillCurve.js";
import { witherScore } from "./wither.js";

export interface SnapMap {
  clear: string | null; // first clear day
  onem: string | null; // mania: first 1,000,000 day (null elsewhere)
  rankedDay: string | null; // day the map entered the catalog
  loved: boolean; // status 4 (vs ranked/approved)
  sr: number;
  /** 0.1★ slice (star_rating * 10, capped) — the skill curve's own bucket */
  q: number;
  /** basic object count, to convert a predicted standardised score to classic */
  n: number;
  year: string | null;
  len: number;
  combo: number;
  ar: number;
  od: number;
  cs: number;
  hp: number;
  /** fine buckets for the score-curve panel (index in its dimension, -1 unknown) */
  arQ: number;
  odQ: number;
  csQ: number;
  hpQ: number;
  len10: number;
  comboQ: number;
  month: number;
}

/** [day, gradeCode 0..5, fc_state, standardised, classic, rateBucket] */
export type BestTransition = [string, number, number, number, number, number];
/** [day, held 0|1] */
export type CountryTransition = [string, number];
/** [day, rank | 0] */
export type GlobalTransition = [string, number];

/** Everything the replay reads; the cache entry of stats.ts satisfies it. */
export interface SnapshotData {
  maps: SnapMap[];
  country: (CountryTransition[] | undefined)[];
  bests: (BestTransition[] | undefined)[];
  global: (GlobalTransition[] | undefined)[];
}

/** The extra per-bucket gauges, on top of total/played/fc/country. */
export const SNAP_GAUGE_KEYS = [
  "pfc", "nonfc", "ss", "gradeS", "gradeA", "gradeB", "gradeC", "gradeD",
  "onem",
] as const;
export type SnapGaugeKey = (typeof SNAP_GAUGE_KEYS)[number];
const TOP_TIERS = [1, 8, 15, 25, 50, 100] as const;
const AGG_KEYS = [
  "total", "played", "fc", "country",
  ...SNAP_GAUGE_KEYS,
  ...TOP_TIERS.map((t) => `top${t}` as const),
] as const;
type Agg = Record<(typeof AGG_KEYS)[number], number>;
/** what one map contributed at that date (an object beats 14 booleans) */
type Hit = {
  inCat: boolean;
  played: boolean;
  fc: boolean;
  country: boolean;
  /** global position, 0 = none */
  rank: number;
} & Record<SnapGaugeKey, boolean>;
const mkAgg = (): Agg =>
  Object.fromEntries(AGG_KEYS.map((k) => [k, 0])) as Agg;
const addHit = (a: Agg, h: Hit) => {
  if (h.inCat) a.total++;
  if (h.played) a.played++;
  if (h.fc) a.fc++;
  if (h.country) a.country++;
  for (const k of SNAP_GAUGE_KEYS) if (h[k]) a[k]++;
  if (h.rank > 0)
    for (const t of TOP_TIERS) if (h.rank <= t) a[`top${t}`]++;
};

/** Score-curve x-axes the snapshot can bucket on (anything else: sr). */
export const SNAP_DIM_INDEX: Record<string, (m: SnapMap) => number> = {
  ar: (m) => m.arQ,
  od: (m) => m.odQ,
  cs: (m) => m.csQ,
  hp: (m) => m.hpQ,
  length: (m) => m.len10,
  combo: (m) => m.comboQ,
  month: (m) => m.month,
};

/**
 * Replays every map's transitions up to `day` (inclusive) and aggregates the
 * whole dashboard: per-dimension buckets, hero rows per status, grade/FC
 * counts, global tops, score and missing sums, and the re-fitted score curve.
 * `dimSteps` = bucket count of `curveDim` (CURVE_STEPS when it is "sr").
 */
export function replaySnapshot(
  R: number,
  data: SnapshotData,
  day: string,
  curveDim: string,
  dimSteps: number
): Record<string, unknown> {
  const { maps, country, bests, global } = data;
  const n = maps.length;
  // ONE walk of the transitions per map, reused by every consumer below.
  // Typed arrays: no allocation churn on a request that fires per slider tick.
  const bestStd = new Float64Array(n);
  const bestClassic = new Float64Array(n);
  const fcStateAt = new Int8Array(n).fill(-1); // -1 = not played that day
  const gradeAt = new Int8Array(n); // 5 = SS, 4 = S+, 3 = A, 2 = B, 1 = C, 0 = D
  const rateAt = new Int8Array(n); // rate*10 of that best, 0 = not played
  const rankAt = new Int32Array(n);
  const c1At = new Uint8Array(n);
  // The SR fit is ALWAYS computed — the missing estimates are defined against
  // it — a second, display-only fit is added for any other selected axis.
  const dimIdxOf: ((m: SnapMap) => number) | null =
    Object.prototype.hasOwnProperty.call(SNAP_DIM_INDEX, curveDim)
      ? SNAP_DIM_INDEX[curveDim]
      : null;
  const qs: number[][] = [];
  for (let q = 0; q <= CURVE_STEPS; q++) qs.push([]);
  const qs2: number[][] = [];
  if (dimIdxOf) for (let q = 0; q <= dimSteps; q++) qs2.push([]);
  for (let i = 0; i < n; i++) {
    const m = maps[i];
    if (m.clear != null && m.clear <= day) {
      const tr = bests[i];
      if (tr)
        for (let k = 0; k < tr.length; k++) {
          const t = tr[k];
          if (t[0] > day) break;
          gradeAt[i] = t[1];
          fcStateAt[i] = t[2];
          bestStd[i] = t[3];
          bestClassic[i] = t[4];
          rateAt[i] = t[5];
        }
      if (m.q >= 0 && bestStd[i] > 0) qs[m.q].push(bestStd[i]);
      if (dimIdxOf && bestStd[i] > 0) {
        const dq = dimIdxOf(m);
        if (dq >= 0 && dq <= dimSteps) qs2[dq].push(bestStd[i]);
      }
      const ct = country[i];
      if (ct)
        for (let k = 0; k < ct.length; k++) {
          if (ct[k][0] > day) break;
          c1At[i] = ct[k][1] as 0 | 1;
        }
    }
    const gt = global[i];
    if (gt)
      for (let k = 0; k < gt.length; k++) {
        if (gt[k][0] > day) break;
        rankAt[i] = gt[k][1];
      }
  }
  // The curve is RE-FITTED on those bests: comparing today's level against
  // past scores would make the historical missing meaningless.
  const byQ = new Map<number, number[]>();
  for (let q = 0; q <= CURVE_STEPS; q++) if (qs[q].length) byQ.set(q, qs[q]);
  const curve = fitSkillCurve(byQ);
  const byQ2 = new Map<number, number[]>();
  if (dimIdxOf)
    for (let q = 0; q <= dimSteps; q++) if (qs2[q].length) byQ2.set(q, qs2[q]);
  const dispCurve = dimIdxOf ? fitSkillCurve(byQ2, dimSteps) : curve;

  // Buckets are small integers: plain arrays instead of Map.get() 1.2M times
  const AGG_LEN = 19; // mania "CS" (key count) reaches 18
  const arr = (len = AGG_LEN) => Array.from({ length: len }, mkAgg);
  const dims = {
    bySr: arr(), byLen: arr(), byCombo: arr(),
    byAr: arr(), byOd: arr(), byCs: arr(), byHp: arr(),
    byRate: arr(21), // rate*10, 0.5x-2.0x
  };
  const byYear = new Map<string, Agg>(); // the only non-numeric dimension
  // hero rows (All / Ranked / Loved) need the same gauges as the dists
  const byStatus = { ranked: mkAgg(), loved: mkAgg() };
  // per-band aggregates for the historical curve panel, indexed by the
  // dimension it is looking at (SR by default)
  const curveTotal = new Int32Array(dimSteps + 1);
  const curvePlayed = new Int32Array(dimSteps + 1);
  const curveMissC = new Float64Array(dimSteps + 1);
  const curveMissW = new Float64Array(dimSteps + 1);
  let missing = 0;
  let missingClassic = 0;
  let missingWither = 0;
  // ranked score at that date, in the three units the hero shows
  let rankedStd = 0;
  let rankedClassic = 0;
  let rankedWither = 0;
  const tops = { top1: 0, top8: 0, top15: 0, top25: 0, top50: 0, top100: 0, checked: 0 };
  const fcCounts = [0, 0, 0];
  const bumpArr = (a: Agg[], key: number, h: Hit) => {
    if (key >= 0 && key < a.length) addHit(a[key], h);
  };

  for (let i = 0; i < n; i++) {
    const m = maps[i];
    const inCat = m.rankedDay != null && m.rankedDay <= day;
    const cleared = fcStateAt[i] >= 0;
    // best AT THAT DATE, replayed above: a higher non-FC score set LATER is
    // not in fcStateAt[i] yet, so it cannot take this FC away retroactively
    const fced = cleared && fcStateAt[i] <= 1;
    const onemd = m.onem != null && m.onem <= day;
    const rank = inCat ? rankAt[i] : 0;

    if (inCat) {
      // the panel aggregates follow the SELECTED dimension (a map with an
      // unknown SR still lands in its AR/length/... band, like the live
      // curve); the missing itself stays defined against the SR curve
      const dq = dimIdxOf ? dimIdxOf(m) : m.q;
      const inBand = dq >= 0 && dq <= dimSteps;
      if (inBand) {
        curveTotal[dq]++;
        if (cleared) curvePlayed[dq]++;
      }
      if (m.q >= 0) {
        const pred = curve[m.q].value;
        const mc = Math.max(0, classicFromStandardised(R, pred, m.n) - bestClassic[i]);
        missing += Math.max(0, pred - bestStd[i]);
        missingClassic += mc;
        if (inBand) curveMissC[dq] += mc;
        if (R === 0 && m.n > 0) {
          const mw = Math.max(0, witherScore(pred, m.n) - witherScore(bestStd[i], m.n));
          missingWither += mw;
          if (inBand) curveMissW[dq] += mw;
        }
      }
    }
    if (inCat && cleared) {
      fcCounts[fcStateAt[i]]++;
      rankedStd += bestStd[i];
      rankedClassic += bestClassic[i];
      if (R === 0 && m.n > 0) rankedWither += witherScore(bestStd[i], m.n);
    }
    if (rank > 0) {
      tops.checked++;
      if (rank === 1) tops.top1++;
      if (rank <= 8) tops.top8++;
      if (rank <= 15) tops.top15++;
      if (rank <= 25) tops.top25++;
      if (rank <= 50) tops.top50++;
      if (rank <= 100) tops.top100++;
    }

    const c1 = cleared && c1At[i] === 1;
    // (!fced is implied by !cleared now that it derives from the best)
    if (!inCat && !cleared && !c1 && rank === 0) continue;
    const h: Hit = {
      inCat, played: cleared, fc: fced, country: c1,
      pfc: cleared && fcStateAt[i] === 0,
      nonfc: cleared && !fced,
      ss: gradeAt[i] === 5,
      gradeS: gradeAt[i] === 4,
      gradeA: gradeAt[i] === 3,
      gradeB: gradeAt[i] === 2,
      gradeC: gradeAt[i] === 1,
      gradeD: cleared && gradeAt[i] === 0,
      onem: onemd,
      rank,
    };
    addHit(m.loved ? byStatus.loved : byStatus.ranked, h);
    bumpArr(dims.bySr, m.sr, h);
    bumpArr(dims.byLen, m.len, h);
    bumpArr(dims.byCombo, m.combo, h);
    bumpArr(dims.byAr, m.ar, h);
    bumpArr(dims.byOd, m.od, h);
    bumpArr(dims.byCs, m.cs, h);
    bumpArr(dims.byHp, m.hp, h);
    // a rate belongs to the SCORE: only a map WITH a best that day has one
    if (cleared && rateAt[i] > 0) bumpArr(dims.byRate, rateAt[i], h);
    if (m.year != null) {
      let a = byYear.get(m.year);
      if (!a) byYear.set(m.year, (a = mkAgg()));
      addHit(a, h);
    }
  }
  const out = (a: Agg[]) =>
    a.map((agg, bucket) => ({ bucket, ...agg })).filter((r) => r.total || r.played || r.country || r.fc);
  const outYear = () => [...byYear.entries()].map(([bucket, a]) => ({ bucket, ...a }));
  return {
    day,
    bySr: out(dims.bySr), byYear: outYear(), byLen: out(dims.byLen),
    byCombo: out(dims.byCombo), byAr: out(dims.byAr), byOd: out(dims.byOd),
    byCs: out(dims.byCs), byHp: out(dims.byHp), byRate: out(dims.byRate),
    byStatus: [
      { bucket: "ranked", ...byStatus.ranked },
      { bucket: "loved", ...byStatus.loved },
    ],
    fc: fcCounts.map((c, fc_state) => ({ fc_state, c })).filter((f) => f.c > 0),
    globalTops: tops,
    scoreSums: {
      lazer: Math.round(rankedStd),
      classic: Math.round(rankedClassic),
      wither: Math.round(rankedWither),
    },
    missingSums: {
      missing: Math.round(missing),
      missingClassic: Math.round(missingClassic),
      missingWither: Math.round(missingWither),
    },
    // same shape as /skill-curve, so the panel just swaps its source
    curveDim,
    curve: dispCurve
      .filter((b) => curveTotal[b.q] > 0)
      .map((b) => ({
        q: b.q,
        predicted: b.value,
        raw: b.raw,
        samples: b.samples,
        inherited: b.samples < 5,
        total: curveTotal[b.q],
        played: curvePlayed[b.q],
        missingClassic: Math.round(curveMissC[b.q]),
        missingWither: Math.round(curveMissW[b.q]),
      })),
  };
}
