import { Router } from "express";
import { getDb } from "../db/db.js";
import {
  CURVE_STEPS,
  N_OBJ,
  computeSkillCurve,
  ensureMissingFresh,
  witherSql,
} from "../logic/scoreSql.js";

export const statsRouter = Router();

statsRouter.get("/stats", (_req, res) => {
  ensureMissingFresh();
  const db = getDb();
  const one = <T>(sql: string) => db.prepare(sql).get() as T;

  const totals = one<{
    total: number;
    played: number;
    fetched: number;
    ranked_total: number;
    ranked_played: number;
    loved_total: number;
    loved_played: number;
    country_firsts: number;
    country_ranked: number;
    country_loved: number;
    fc: number;
    fc_ranked: number;
    fc_loved: number;
  }>(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
      SUM(CASE WHEN u.fetched_at IS NOT NULL THEN 1 ELSE 0 END) fetched,
      SUM(CASE WHEN b.status IN (1, 2) THEN 1 ELSE 0 END) ranked_total,
      SUM(CASE WHEN b.status IN (1, 2) AND u.played = 1 THEN 1 ELSE 0 END) ranked_played,
      SUM(CASE WHEN b.status = 4 THEN 1 ELSE 0 END) loved_total,
      SUM(CASE WHEN b.status = 4 AND u.played = 1 THEN 1 ELSE 0 END) loved_played,
      SUM(COALESCE(u.country_first, 0)) country_firsts,
      SUM(CASE WHEN b.status IN (1, 2) THEN COALESCE(u.country_first, 0) ELSE 0 END) country_ranked,
      SUM(CASE WHEN b.status = 4 THEN COALESCE(u.country_first, 0) ELSE 0 END) country_loved,
      SUM(COALESCE(u.any_fc, 0)) fc,
      SUM(CASE WHEN b.status IN (1, 2) THEN COALESCE(u.any_fc, 0) ELSE 0 END) fc_ranked,
      SUM(CASE WHEN b.status = 4 THEN COALESCE(u.any_fc, 0) ELSE 0 END) fc_loved
    FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
    WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)`);

  const scoreSums = one<{
    lazer: number;
    classic: number;
    wither: number;
  }>(`
    SELECT
      COALESCE(SUM(s.total_score), 0) lazer,
      COALESCE(SUM(COALESCE(s.classic_total_score, s.total_score)), 0) classic,
      COALESCE(SUM(CASE WHEN ${N_OBJ} > 0
        THEN ${witherSql("s.total_score")}
        ELSE s.total_score END), 0) wither
    FROM beatmap_user u
    JOIN beatmaps b ON b.id = u.beatmap_id
    LEFT JOIN scores s ON s.id = u.best_lazer_score_id
    WHERE u.played = 1`);

  // Total realistic missing over the WHOLE catalog: unplayed maps count for
  // their full prediction.
  const missingSums = one<{
    missing: number;
    missingClassic: number;
    missingWither: number;
  }>(`
    SELECT
      COALESCE(SUM(u.missing_lazer), 0) missing,
      COALESCE(SUM(u.missing_classic), 0) missingClassic,
      COALESCE(SUM(u.missing_wither), 0) missingWither
    FROM beatmaps b
    LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
    LEFT JOIN scores s ON s.id = u.best_lazer_score_id
    WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)`);

  // Global tops counters (cumulative: top8 includes top1, etc.). All zeros
  // until the global sweep has run at least once.
  const globalTops = one<{
    top1: number; top8: number; top15: number;
    top25: number; top50: number; top100: number;
    checked: number;
  }>(`
    SELECT
      COALESCE(SUM(u.global_rank = 1), 0) top1,
      COALESCE(SUM(u.global_rank <= 8), 0) top8,
      COALESCE(SUM(u.global_rank <= 15), 0) top15,
      COALESCE(SUM(u.global_rank <= 25), 0) top25,
      COALESCE(SUM(u.global_rank <= 50), 0) top50,
      COALESCE(SUM(u.global_rank <= 100), 0) top100,
      COUNT(*) checked
    FROM beatmap_user u
    JOIN beatmaps b ON b.id = u.beatmap_id
    WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND u.global_rank IS NOT NULL`);

  // osu! leaderboard semantics: the map's grade/FC state = that of the score
  // that counts on the LB, i.e. the BEST by score (not the best grade).
  const grades = db
    .prepare(
      `SELECT s.rank AS grade, COUNT(*) c
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)
       GROUP BY s.rank`
    )
    .all();

  const fc = db
    .prepare(
      `SELECT s.fc_state, COUNT(*) c
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)
       GROUP BY s.fc_state`
    )
    .all();

  const bySr = db
    .prepare(
      `SELECT MIN(CAST(b.star_rating AS INTEGER), 10) sr,
        COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
        SUM(COALESCE(u.country_first, 0)) country,
        SUM(COALESCE(u.any_fc, 0)) fc
       FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND b.star_rating IS NOT NULL
       GROUP BY sr ORDER BY sr`
    )
    .all();

  const byYear = db
    .prepare(
      `SELECT strftime('%Y', st.ranked_date) year,
        COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
        SUM(COALESCE(u.country_first, 0)) country,
        SUM(COALESCE(u.any_fc, 0)) fc
       FROM beatmaps b
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       WHERE b.ruleset = 0 AND st.ranked_date IS NOT NULL
       GROUP BY year ORDER BY year`
    )
    .all();

  // Generic distributions by capped integer bucket (AR/OD/HP/CS, length, combo)
  const dist = (expr: string, cap: number) =>
    db
      .prepare(
        `SELECT MIN(CAST(${expr} AS INTEGER), ${cap}) AS bucket,
          COUNT(*) total, SUM(CASE WHEN u.played = 1 THEN 1 ELSE 0 END) played,
          SUM(COALESCE(u.country_first, 0)) country,
          SUM(COALESCE(u.any_fc, 0)) fc
         FROM beatmaps b LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
         WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND ${expr} IS NOT NULL
         GROUP BY bucket ORDER BY bucket`
      )
      .all();

  const byAr = dist("b.ar", 10);
  const byOd = dist("b.od", 10);
  const byHp = dist("b.hp", 10);
  const byCs = dist("b.cs", 10);
  const byLen = dist("b.total_length / 60", 10); // one-minute buckets
  const byCombo = dist("b.max_combo / 250", 8); // buckets of 250, 2000+

  res.json({
    totals, scoreSums: { ...scoreSums, ...missingSums }, grades, fc, globalTops,
    bySr, byYear, byAr, byOd, byHp, byCs, byLen, byCombo,
  });
});

/**
 * GET /api/skill-curve — skill curve detail per 0.1★ slice: retained
 * prediction, number of bests backing it (inherited slice if < 5), maps in the
 * slice and cumulative realistic missing (standardised).
 */
statsRouter.get("/skill-curve", (_req, res) => {
  ensureMissingFresh();
  const db = getDb();
  const { buckets } = computeSkillCurve();
  const aggs = db
    .prepare(
      `SELECT MIN(CAST(b.star_rating * 10 AS INTEGER), ${CURVE_STEPS}) AS q,
        COUNT(*) total,
        SUM(COALESCE(u.played, 0)) played,
        SUM(u.missing_classic) missing_classic,
        SUM(u.missing_wither) missing_wither
       FROM beatmaps b
       LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
       LEFT JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND b.star_rating IS NOT NULL
       GROUP BY q ORDER BY q`
    )
    .all() as {
    q: number;
    total: number;
    played: number | null;
    missing_classic: number | null;
    missing_wither: number | null;
  }[];
  const byQ = new Map(aggs.map((a) => [a.q, a]));
  res.json({
    buckets: buckets
      .filter((b) => (byQ.get(b.q)?.total ?? 0) > 0)
      .map((b) => {
        const a = byQ.get(b.q)!;
        return {
          sr: b.q / 10,
          predicted: b.value,
          samples: b.samples,
          inherited: b.samples < 5, // not enough bests => carried-over value
          total: a.total,
          played: a.played ?? 0,
          missingClassic: a.missing_classic ?? 0,
          missingWither: a.missing_wither ?? 0,
        };
      }),
  });
});

/**
 * GET /api/daily?year=YYYY — clears per day (first qualifying score of each
 * map) for the heatmap, plus all-time streak stats. Cheap: one GROUP BY.
 */
statsRouter.get("/daily", (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT date(m.at) d, COUNT(*) c FROM (
         SELECT MIN(s.ended_at) AS at FROM scores s
         JOIN beatmaps b ON b.id = s.beatmap_id
         WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND s.passed = 1
         GROUP BY s.beatmap_id
       ) m GROUP BY d ORDER BY d`
    )
    .all() as { d: string; c: number }[];

  // streaks over ALL days with at least one new clear
  const daySet = new Set(rows.map((r) => r.d));
  const DAY = 86_400_000;
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  for (const r of rows) {
    const t = Date.parse(r.d);
    run = prev != null && t - prev === DAY ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = t;
  }
  // current streak: counts back from today (or yesterday, still extendable)
  let current = 0;
  let cursor = new Date().toISOString().slice(0, 10);
  if (!daySet.has(cursor))
    cursor = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  while (daySet.has(cursor)) {
    current++;
    cursor = new Date(Date.parse(cursor) - DAY).toISOString().slice(0, 10);
  }
  const best = rows.reduce(
    (acc, r) => (r.c > acc.c ? r : acc),
    { d: "", c: 0 }
  );

  const year = Number(req.query.year) || new Date().getUTCFullYear();
  const years = rows.length
    ? { min: Number(rows[0].d.slice(0, 4)), max: Number(rows[rows.length - 1].d.slice(0, 4)) }
    : { min: year, max: year };
  res.json({
    year,
    years,
    days: rows.filter((r) => r.d.startsWith(String(year))),
    streak: { current, longest, best },
  });
});

/**
 * GET /api/timeline — cumulative daily snapshot of the account: clears / FCs /
 * country #1s (split all/ranked/loved), ranked classic, and the grade spread
 * (highest grade achieved per map — close to, but not exactly, the live
 * "grade of the best score"). One point per active day, whole series shipped
 * at once so the time-machine slider is instant client-side. Cached by scores
 * version.
 */
let timelineCache: { version: string; payload: unknown } | null = null;

const TIERS = ["D", "C", "B", "A", "S", "SH", "X", "XH"];

statsRouter.get("/timeline", (_req, res) => {
  const db = getDb();
  const v = db
    .prepare("SELECT COUNT(*) c, COALESCE(MAX(id), 0) m FROM scores")
    .get() as { c: number; m: number };
  const version = `${v.c}-${v.m}`;
  if (timelineCache && timelineCache.version === version)
    return res.json(timelineCache.payload);

  const CATALOG = `FROM scores s JOIN beatmaps b ON b.id = s.beatmap_id
    WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)`;
  const firstDates = (cond: string): string[] =>
    (
      db
        .prepare(
          `SELECT MIN(s.ended_at) AS at ${CATALOG} AND ${cond} GROUP BY s.beatmap_id ORDER BY at`
        )
        .all() as { at: string }[]
    ).map((r) => r.at);
  const clears = firstDates("s.passed = 1");
  const clearsRanked = firstDates("s.passed = 1 AND b.status IN (1, 2)");
  const clearsLoved = firstDates("s.passed = 1 AND b.status = 4");
  const fcAll = firstDates("s.passed = 1 AND s.fc_state <= 1");
  const fcRanked = firstDates("s.passed = 1 AND s.fc_state <= 1 AND b.status IN (1, 2)");
  const fcLoved = firstDates("s.passed = 1 AND s.fc_state <= 1 AND b.status = 4");

  // ranked classic + grade spread: one replay of successive bests. The tier
  // counted is the grade OF THE CURRENT BEST (classic) score — the same
  // definition as the dashboard's Grades panel, so an SS later beaten by a
  // higher-scoring S stops counting as SS from that moment on.
  const scoreRows = db
    .prepare(
      `SELECT s.beatmap_id AS bid, s.ended_at AS at, s.rank AS rank,
         COALESCE(s.classic_total_score, s.total_score) AS v
       ${CATALOG} AND s.passed = 1 ORDER BY s.ended_at`
    )
    .all() as { bid: number; at: string; rank: string; v: number }[];
  const tierOf = new Map(TIERS.map((t, i) => [t, i]));
  const best = new Map<number, number>();
  const mapTier = new Map<number, number>();
  const gradeEvents: { at: string; to: number | null; from: number | null }[] = [];
  let rankedTotal = 0;
  const rankedPts: { at: string; total: number }[] = [];
  for (const r of scoreRows) {
    const prev = best.get(r.bid) ?? 0;
    if (r.v <= prev) continue;
    best.set(r.bid, r.v);
    rankedTotal += r.v - prev;
    rankedPts.push({ at: r.at, total: rankedTotal });
    const to = tierOf.get(r.rank) ?? null;
    const from = mapTier.get(r.bid) ?? null;
    if (to !== from) {
      gradeEvents.push({ at: r.at, to, from });
      if (to == null) mapTier.delete(r.bid);
      else mapTier.set(r.bid, to);
    }
  }

  // country #1s: logged transitions + silent initial takes dated to my best
  const events = db
    .prepare(
      `SELECT e.beatmap_id AS bid, e.event, COALESCE(e.score_at, e.at) AS at,
         b.status AS status
       FROM country_events e JOIN beatmaps b ON b.id = e.beatmap_id
       ORDER BY COALESCE(e.score_at, e.at)`
    )
    .all() as { bid: number; event: string; at: string; status: number }[];
  const byMap = new Map<number, typeof events>();
  for (const e of events) {
    const arr = byMap.get(e.bid) ?? [];
    arr.push(e);
    byMap.set(e.bid, arr);
  }
  const held = db
    .prepare(
      `SELECT u.beatmap_id AS bid, s.ended_at AS at, b.status AS status
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE u.country_first = 1 AND b.ruleset = 0`
    )
    .all() as { bid: number; at: string; status: number }[];
  const deltas: { at: string; delta: number; status: number }[] = [];
  for (const r of held)
    if (!byMap.has(r.bid)) deltas.push({ at: r.at, delta: 1, status: r.status });
  for (const [, evs] of byMap) {
    if (evs[0].event === "lost")
      deltas.push({ at: evs[0].at, delta: 1, status: evs[0].status });
    for (const e of evs)
      deltas.push({ at: e.at, delta: e.event === "gained" ? 1 : -1, status: e.status });
  }
  deltas.sort((a, b) => a.at.localeCompare(b.at));

  // catalog growth: how many maps existed (were ranked/loved) at each date
  const hist = db
    .prepare(
      `SELECT date(st.ranked_date) d,
         COUNT(*) total,
         SUM(CASE WHEN b.status IN (1, 2) THEN 1 ELSE 0 END) r,
         SUM(CASE WHEN b.status = 4 THEN 1 ELSE 0 END) l
       FROM beatmaps b JOIN beatmapsets st ON st.id = b.beatmapset_id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4) AND st.ranked_date IS NOT NULL
       GROUP BY d ORDER BY d`
    )
    .all() as { d: string; total: number; r: number; l: number }[];

  // merge everything on the union of active days
  const dayOf = (iso: string) => iso.slice(0, 10);
  const days = [
    ...new Set([
      ...clears.map(dayOf),
      ...fcAll.map(dayOf),
      ...gradeEvents.map((e) => dayOf(e.at)),
      ...rankedPts.map((p) => dayOf(p.at)),
      ...deltas.map((d) => dayOf(d.at)),
    ]),
  ].sort();

  const idx = { c: 0, cr: 0, cl: 0, f: 0, fr: 0, fl: 0, g: 0, r: 0, d: 0, h: 0 };
  let ranked = 0;
  const catalog = { total: 0, ranked: 0, loved: 0 };
  const country = { all: 0, ranked: 0, loved: 0 };
  const grades = new Array(TIERS.length).fill(0) as number[];
  const advance = (arr: string[], key: "c" | "cr" | "cl" | "f" | "fr" | "fl", day: string) => {
    while (idx[key] < arr.length && dayOf(arr[idx[key]]) <= day) idx[key]++;
    return idx[key];
  };
  const points = days.map((day) => {
    const c = advance(clears, "c", day);
    const cr = advance(clearsRanked, "cr", day);
    const cl = advance(clearsLoved, "cl", day);
    const f = advance(fcAll, "f", day);
    const fr = advance(fcRanked, "fr", day);
    const fl = advance(fcLoved, "fl", day);
    while (idx.g < gradeEvents.length && dayOf(gradeEvents[idx.g].at) <= day) {
      const e = gradeEvents[idx.g++];
      if (e.to != null) grades[e.to]++;
      if (e.from != null) grades[e.from]--;
    }
    while (idx.r < rankedPts.length && dayOf(rankedPts[idx.r].at) <= day)
      ranked = rankedPts[idx.r++].total;
    while (idx.d < deltas.length && dayOf(deltas[idx.d].at) <= day) {
      const d = deltas[idx.d++];
      country.all += d.delta;
      if (d.status === 4) country.loved += d.delta;
      else country.ranked += d.delta;
    }
    while (idx.h < hist.length && hist[idx.h].d <= day) {
      catalog.total += hist[idx.h].total;
      catalog.ranked += hist[idx.h].r;
      catalog.loved += hist[idx.h].l;
      idx.h++;
    }
    return {
      day,
      total: catalog.total, totalRanked: catalog.ranked, totalLoved: catalog.loved,
      clears: c, clearsRanked: cr, clearsLoved: cl,
      fc: f, fcRanked: fr, fcLoved: fl,
      ranked,
      country: country.all, countryRanked: country.ranked, countryLoved: country.loved,
      grades: [...grades], // D,C,B,A,S,SH,X,XH
    };
  });
  const payload = { tiers: TIERS, points };
  timelineCache = { version, payload };
  res.json(payload);
});

/**
 * GET /api/snapshot?day=YYYY-MM-DD — per-dimension completion (star rating,
 * rank year, length, combo, AR/OD/CS/HP) at a past date, for the time-machine
 * slider. A per-map index (first clear / first FC / country transitions +
 * bucket attributes) is cached by scores version; each request is then a pure
 * in-memory aggregation (~10 ms over 150k maps).
 */
interface SnapMap {
  clear: string | null; // first clear day
  fc: string | null; // first FC day
  rankedDay: string | null; // day the map entered the catalog
  sr: number;
  year: string | null;
  len: number;
  combo: number;
  ar: number;
  od: number;
  cs: number;
  hp: number;
}
let snapCache: {
  version: string;
  maps: SnapMap[];
  country: Map<number, [string, number][]>; // bid -> [day, held 0|1] transitions
  mapIds: number[];
} | null = null;

function buildSnapshotIndex(db: ReturnType<typeof getDb>): NonNullable<typeof snapCache> {
  const attrs = db
    .prepare(
      `SELECT b.id, b.star_rating sr, b.total_length len, b.max_combo combo,
         b.ar, b.od, b.cs, b.hp, strftime('%Y', st.ranked_date) year,
         date(st.ranked_date) ranked_day,
         MIN(CASE WHEN s.passed = 1 THEN s.ended_at END) clear,
         MIN(CASE WHEN s.passed = 1 AND s.fc_state <= 1 THEN s.ended_at END) fc
       FROM beatmaps b
       JOIN beatmapsets st ON st.id = b.beatmapset_id
       LEFT JOIN scores s ON s.beatmap_id = b.id
       WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)
       GROUP BY b.id`
    )
    .all() as {
    id: number; sr: number | null; len: number | null; combo: number | null;
    ar: number | null; od: number | null; cs: number | null; hp: number | null;
    year: string | null; ranked_day: string | null;
    clear: string | null; fc: string | null;
  }[];
  const cap = (v: number | null, c: number) =>
    v == null ? -1 : Math.min(Math.floor(v), c);
  const maps: SnapMap[] = [];
  const mapIds: number[] = [];
  for (const a of attrs) {
    mapIds.push(a.id);
    maps.push({
      clear: a.clear ? a.clear.slice(0, 10) : null,
      fc: a.fc ? a.fc.slice(0, 10) : null,
      rankedDay: a.ranked_day,
      sr: cap(a.sr, 10),
      year: a.year,
      len: a.len == null ? -1 : Math.min(Math.floor(a.len / 60), 10),
      combo: a.combo == null ? -1 : Math.min(Math.floor(a.combo / 250), 8),
      ar: cap(a.ar, 10), od: cap(a.od, 10), cs: cap(a.cs, 10), hp: cap(a.hp, 10),
    });
  }

  // country #1 state transitions per map (same approximation as /timeline)
  const events = db
    .prepare(
      `SELECT beatmap_id AS bid, event, COALESCE(score_at, at) AS at
       FROM country_events ORDER BY COALESCE(score_at, at)`
    )
    .all() as { bid: number; event: string; at: string }[];
  const country = new Map<number, [string, number][]>();
  for (const e of events) {
    const arr = country.get(e.bid) ?? [];
    if (arr.length === 0 && e.event === "lost")
      arr.push([e.at.slice(0, 10), 1]); // silent gain before the recorded loss
    arr.push([e.at.slice(0, 10), e.event === "gained" ? 1 : 0]);
    country.set(e.bid, arr);
  }
  const held = db
    .prepare(
      `SELECT u.beatmap_id AS bid, s.ended_at AS at
       FROM beatmap_user u
       JOIN beatmaps b ON b.id = u.beatmap_id
       JOIN scores s ON s.id = u.best_lazer_score_id
       WHERE u.country_first = 1 AND b.ruleset = 0`
    )
    .all() as { bid: number; at: string }[];
  for (const r of held)
    if (!country.has(r.bid)) country.set(r.bid, [[r.at.slice(0, 10), 1]]);

  const v = db
    .prepare("SELECT COUNT(*) c, COALESCE(MAX(id), 0) m FROM scores")
    .get() as { c: number; m: number };
  return { version: `${v.c}-${v.m}`, maps, country, mapIds };
}

statsRouter.get("/snapshot", (req, res) => {
  const day = String(req.query.day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    return res.status(400).json({ ok: false, error: "day=YYYY-MM-DD required" });
  const db = getDb();
  const v = db
    .prepare("SELECT COUNT(*) c, COALESCE(MAX(id), 0) m FROM scores")
    .get() as { c: number; m: number };
  if (!snapCache || snapCache.version !== `${v.c}-${v.m}`)
    snapCache = buildSnapshotIndex(db);

  type Agg = { total: number; played: number; fc: number; country: number };
  const mk = () => new Map<string | number, Agg>();
  const dims = {
    bySr: mk(), byYear: mk(), byLen: mk(), byCombo: mk(),
    byAr: mk(), byOd: mk(), byCs: mk(), byHp: mk(),
  };
  const bump = (
    m: Map<string | number, Agg>,
    key: string | number | null,
    inCat: boolean, c: boolean, f: boolean, c1: boolean
  ) => {
    if (key == null || key === -1) return;
    let a = m.get(key);
    if (!a) m.set(key, (a = { total: 0, played: 0, fc: 0, country: 0 }));
    if (inCat) a.total++;
    if (c) a.played++;
    if (f) a.fc++;
    if (c1) a.country++;
  };
  const { maps, country, mapIds } = snapCache;
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    const inCat = m.rankedDay != null && m.rankedDay <= day;
    const cleared = m.clear != null && m.clear <= day;
    const fced = m.fc != null && m.fc <= day;
    let c1 = false;
    if (cleared) {
      const tr = country.get(mapIds[i]);
      if (tr) {
        for (const [d, state] of tr) {
          if (d > day) break;
          c1 = state === 1;
        }
      }
    }
    if (!inCat && !cleared && !fced && !c1) continue;
    bump(dims.bySr, m.sr, inCat, cleared, fced, c1);
    bump(dims.byYear, m.year, inCat, cleared, fced, c1);
    bump(dims.byLen, m.len, inCat, cleared, fced, c1);
    bump(dims.byCombo, m.combo, inCat, cleared, fced, c1);
    bump(dims.byAr, m.ar, inCat, cleared, fced, c1);
    bump(dims.byOd, m.od, inCat, cleared, fced, c1);
    bump(dims.byCs, m.cs, inCat, cleared, fced, c1);
    bump(dims.byHp, m.hp, inCat, cleared, fced, c1);
  }
  const out = (m: Map<string | number, Agg>) =>
    [...m.entries()].map(([bucket, a]) => ({ bucket, ...a }));
  res.json({
    day,
    bySr: out(dims.bySr), byYear: out(dims.byYear), byLen: out(dims.byLen),
    byCombo: out(dims.byCombo), byAr: out(dims.byAr), byOd: out(dims.byOd),
    byCs: out(dims.byCs), byHp: out(dims.byHp),
  });
});

// Compact stats for the stream overlay (?overlay=1) — polled every 5s,
// session deltas are computed client-side vs the first response.
statsRouter.get("/overlay", (_req, res) => {
  const GRADE_KEYS = ["XH", "X", "SH", "S", "A", "B", "C", "D"] as const;
  const gradeCols = GRADE_KEYS.map(
    (k) => `SUM(CASE WHEN s.rank = '${k}' THEN 1 ELSE 0 END) g_${k.toLowerCase()}`
  ).join(",\n        ");
  const row = getDb()
    .prepare(
      `SELECT
        COUNT(*) total_maps,
        SUM(COALESCE(u.played, 0)) clears,
        ${gradeCols},
        SUM(COALESCE(u.any_fc, 0)) fc,
        SUM(COALESCE(u.country_first, 0)) country,
        COALESCE(SUM(COALESCE(s.classic_total_score, s.total_score)), 0) ranked_classic,
        COALESCE(SUM(CASE WHEN ${N_OBJ} > 0
          THEN ${witherSql("s.total_score")}
          ELSE s.total_score END), 0) ranked_wither
      FROM beatmaps b
      LEFT JOIN beatmap_user u ON u.beatmap_id = b.id
      LEFT JOIN scores s ON s.id = u.best_lazer_score_id
      WHERE b.ruleset = 0 AND b.status IN (1, 2, 4)`
    )
    .get() as Record<string, number | null> & { total_maps: number };
  const grades: Record<string, number> = {};
  for (const k of GRADE_KEYS) grades[k] = (row[`g_${k.toLowerCase()}`] as number) ?? 0;
  res.json({
    totalMaps: row.total_maps,
    clears: row.clears ?? 0,
    grades,
    fc: row.fc ?? 0,
    country: row.country ?? 0,
    rankedClassic: row.ranked_classic ?? 0,
    rankedWither: row.ranked_wither ?? 0,
  });
});
