/**
 * Custom metrics: a metric counts maps whose scores match a set of conditions,
 * or sums ranked (classic) score. Conditions are compiled to SQL (using
 * SQLite JSON functions for mods and hit counts), so everything stays fast.
 */

export interface Range {
  min: number | null;
  max: number | null;
}

export interface MetricScoreConds {
  fc: "none" | "any" | "pfc" | "nonfc";
  minGrade: string | null; // "A" | "S" (legacy — new metrics use `grades`)
  /** exact grades the score must have (subset of XH X SH S A B C D) */
  grades?: string[] | null;
  minScore: number | null;
  maxScore?: number | null; // upper bound on standardized score
  minClassic: number | null;
  acc?: Range; // accuracy in percent (0-100)
  pp?: Range; // score pp (loved/unranked scores have none and never match a bound)
  allowedMods: string[] | null; // no mod outside this set (null = no limit)
  requiredMods: string[] | null; // must include all of these
  /** must include AT LEAST ONE of these; "NM" in the list also accepts nomod
   * scores (CL alone counts as nomod) */
  anyMods?: string[] | null;
  counts: {
    n100: Range;
    n50: Range;
    nMiss: Range;
    nSliderEnd: Range;
    imperfections: Range; // n100 + missed slider ends
  };
  /** generic per-statistic bounds (non-std rulesets: taiko/catch/mania hit
   * results, keyed by the osu-web statistics name, e.g. "large_tick_hit") */
  hits?: Record<string, Range>;
}

export interface MetricMapConds {
  srMin: number | null; srMax: number | null;
  yearMin: number | null; yearMax: number | null;
  lenMin: number | null; lenMax: number | null;
  arMin: number | null; arMax: number | null;
  odMin: number | null; odMax: number | null;
  csMin: number | null; csMax: number | null;
  hpMin: number | null; hpMax: number | null;
  comboMin: number | null; comboMax: number | null;
  bpmMin: number | null; bpmMax: number | null;
  statuses: number[]; // subset of [1,2,4]; empty = all
  country1: boolean; // only maps where I hold the country #1
  /** my global leaderboard position range (needs the global tops sweep) */
  globalTopMin?: number | null;
  globalTopMax?: number | null;
  ids?: number[] | null; // explicit beatmap ids (custom map pool); null = all
  /** free text over artist / title / mapper / diff name / source / tags */
  query?: string | null;
}

export type MetricBreakdown =
  | "sr" | "year" | "length" | "combo" | "ar" | "od" | "cs" | "hp";

export interface MetricParams {
  kind: "count" | "ranked_score" | "pp";
  /** ruleset the metric lives in (default 0 = osu!std) */
  ruleset?: number;
  /** map pool for non-std rulesets (converts included by default) */
  pool?: "all" | "specific";
  score: MetricScoreConds;
  map: MetricMapConds;
  /** dimension of the per-bucket completion shown on the card (default sr) */
  breakdown?: MetricBreakdown;
  /** count kind (countdown): the conditions select the maps still TO FIX;
   * the count heads to 0, with downward milestones */
  descending?: boolean;
  /** "milestone": progress toward the next step. "total": X / all available maps. */
  progressMode: "milestone" | "total";
  step: number;
  showEvolution: boolean;
}

const GRADE_IN: Record<string, string> = {
  A: "'A','S','SH','X','XH'",
  S: "'S','SH','X','XH'",
};
const GRADES_ALL = ["XH", "X", "SH", "S", "A", "B", "C", "D"];
const MOD_RE = /^[A-Z0-9]{2}$/;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const N100 = "COALESCE(CAST(json_extract(s.statistics,'$.ok') AS INTEGER),0)";
const N50 = "COALESCE(CAST(json_extract(s.statistics,'$.meh') AS INTEGER),0)";
const NMISS = "COALESCE(CAST(json_extract(s.statistics,'$.miss') AS INTEGER),0)";
const SLIDER_END_MISS =
  "MAX(0, COALESCE(CAST(json_extract(s.maximum_statistics,'$.slider_tail_hit') AS INTEGER),0)" +
  " - COALESCE(CAST(json_extract(s.statistics,'$.slider_tail_hit') AS INTEGER),0))";

function range(expr: string, r: Range | undefined, out: string[]): void {
  if (!r) return;
  const lo = num(r.min);
  const hi = num(r.max);
  if (lo != null) out.push(`${expr} >= ${lo}`);
  if (hi != null) out.push(`${expr} <= ${hi}`);
}

/** SQL conditions on a score row (alias `s`). */
export function scoreWhere(c: MetricScoreConds): string {
  const w: string[] = ["s.passed = 1"];
  if (c.fc === "any") w.push("s.fc_state <= 1");
  else if (c.fc === "pfc") w.push("s.fc_state = 0");
  else if (c.fc === "nonfc") w.push("s.fc_state = 2");
  if (c.minGrade && GRADE_IN[c.minGrade])
    w.push(`s.rank IN (${GRADE_IN[c.minGrade]})`);
  if (Array.isArray(c.grades)) {
    const gs = c.grades.filter((g) => GRADES_ALL.includes(g));
    if (gs.length) w.push(`s.rank IN (${gs.map((g) => `'${g}'`).join(",")})`);
  }
  if (num(c.minScore) != null) w.push(`s.total_score >= ${num(c.minScore)}`);
  if (num(c.maxScore) != null) w.push(`s.total_score <= ${num(c.maxScore)}`);
  if (num(c.minClassic) != null)
    w.push(`COALESCE(s.classic_total_score, s.total_score) >= ${num(c.minClassic)}`);
  range("(s.accuracy * 100)", c.acc, w);
  range("s.pp", c.pp, w);
  if (Array.isArray(c.allowedMods)) {
    const list = c.allowedMods.filter((m) => MOD_RE.test(m));
    const inList = list.length ? list.map((m) => `'${m}'`).join(",") : "''";
    w.push(
      `NOT EXISTS (SELECT 1 FROM json_each(s.mods) je WHERE json_extract(je.value,'$.acronym') NOT IN (${inList}))`
    );
  }
  if (Array.isArray(c.requiredMods)) {
    for (const m of c.requiredMods.filter((x) => MOD_RE.test(x)))
      w.push(
        `EXISTS (SELECT 1 FROM json_each(s.mods) je WHERE json_extract(je.value,'$.acronym') = '${m}')`
      );
  }
  if (Array.isArray(c.anyMods) && c.anyMods.length) {
    const list = c.anyMods.filter((m) => m !== "NM" && MOD_RE.test(m));
    const or: string[] = [];
    if (list.length)
      or.push(
        `EXISTS (SELECT 1 FROM json_each(s.mods) je WHERE json_extract(je.value,'$.acronym') IN (${list.map((m) => `'${m}'`).join(",")}))`
      );
    if (c.anyMods.includes("NM"))
      or.push(
        `NOT EXISTS (SELECT 1 FROM json_each(s.mods) je WHERE json_extract(je.value,'$.acronym') <> 'CL')`
      );
    if (or.length) w.push(`(${or.join(" OR ")})`);
  }
  const co = c.counts ?? ({} as MetricScoreConds["counts"]);
  if (c.hits)
    for (const [key, r] of Object.entries(c.hits)) {
      if (!/^[a-z_]{2,32}$/.test(key)) continue;
      range(
        `COALESCE(CAST(json_extract(s.statistics,'$.${key}') AS INTEGER),0)`,
        r,
        w
      );
    }
  range(N100, co.n100, w);
  range(N50, co.n50, w);
  range(NMISS, co.nMiss, w);
  range(SLIDER_END_MISS, co.nSliderEnd, w);
  range(`(${N100} + ${SLIDER_END_MISS})`, co.imperfections, w);
  return w.join(" AND ");
}

/**
 * SQL conditions on the map (aliases `b`, `st`, `u`).
 * `ignoreCountry1` drops the achievement-based filters (country #1, global
 * top) — used for the per-bucket denominator, so such metrics show
 * "my tops / all maps in the range".
 */
export function mapWhere(
  c: MetricMapConds,
  opts: { ignoreCountry1?: boolean; ruleset?: number; pool?: "all" | "specific" } = {}
): string {
  const R = opts.ruleset ?? 0;
  const w: string[] = [
    R === 0 || opts.pool === "specific"
      ? `b.ruleset = ${R}`
      : `(b.ruleset = ${R} OR b.ruleset = 0)`,
  ];
  const sts = (c.statuses ?? []).filter((n) => [1, 2, 4].includes(n));
  w.push(`b.status IN (${(sts.length ? sts : [1, 2, 4]).join(",")})`);
  const r = (expr: string, lo: unknown, hi: unknown) => {
    if (num(lo) != null) w.push(`${expr} >= ${num(lo)}`);
    if (num(hi) != null) w.push(`${expr} <= ${num(hi)}`);
  };
  r("b.star_rating", c.srMin, c.srMax);
  r("CAST(strftime('%Y', st.ranked_date) AS INTEGER)", c.yearMin, c.yearMax);
  r("b.total_length", c.lenMin, c.lenMax);
  r("b.ar", c.arMin, c.arMax);
  r("b.od", c.odMin, c.odMax);
  r("b.cs", c.csMin, c.csMax);
  r("b.hp", c.hpMin, c.hpMax);
  r("b.max_combo", c.comboMin, c.comboMax);
  r("b.bpm", c.bpmMin, c.bpmMax);
  if (c.country1 && !opts.ignoreCountry1)
    w.push("COALESCE(u.country_first, 0) = 1");
  if (!opts.ignoreCountry1) {
    if (num(c.globalTopMin) != null)
      w.push(`u.global_rank >= ${num(c.globalTopMin)}`);
    if (num(c.globalTopMax) != null)
      w.push(`u.global_rank <= ${num(c.globalTopMax)}`);
  }
  if (typeof c.query === "string" && c.query.trim() !== "") {
    const like = `'%${c.query.trim().replaceAll("'", "''")}%'`;
    w.push(
      `(st.artist LIKE ${like} OR st.title LIKE ${like} OR st.creator LIKE ${like}
        OR b.version LIKE ${like} OR COALESCE(st.source,'') LIKE ${like}
        OR COALESCE(st.tags,'') LIKE ${like})`
    );
  }
  if (Array.isArray(c.ids) && c.ids.length) {
    const ids = c.ids
      .filter((v) => Number.isInteger(v) && v > 0)
      .slice(0, 20_000);
    if (ids.length) w.push(`b.id IN (${ids.join(",")})`);
  }
  return w.join(" AND ");
}

export const DEFAULT_SCORE_CONDS: MetricScoreConds = {
  fc: "none",
  minGrade: null,
  grades: null,
  minScore: null,
  maxScore: null,
  minClassic: null,
  acc: { min: null, max: null },
  pp: { min: null, max: null },
  allowedMods: null,
  requiredMods: null,
  anyMods: null,
  counts: {
    n100: { min: null, max: null },
    n50: { min: null, max: null },
    nMiss: { min: null, max: null },
    nSliderEnd: { min: null, max: null },
    imperfections: { min: null, max: null },
  },
};

export const DEFAULT_MAP_CONDS: MetricMapConds = {
  srMin: null, srMax: null, yearMin: null, yearMax: null,
  lenMin: null, lenMax: null, arMin: null, arMax: null,
  odMin: null, odMax: null, csMin: null, csMax: null,
  hpMin: null, hpMax: null, comboMin: null, comboMax: null,
  bpmMin: null, bpmMax: null, statuses: [], country1: false,
  globalTopMin: null, globalTopMax: null, ids: null,
  query: null,
};
