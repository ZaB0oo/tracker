import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { rulesetStatFields } from "../rulesets";
import { fetchSkillCurve, fetchSnapshot, fetchStats, fetchTimeline, type DashScope, type Snapshot, type SnapshotBucket } from "../api";
import { firstPlaceLabel, useCountryCode } from "../country";
import { useDisplayPrefs } from "../prefs";
import { useHidden } from "../visibility";
import { GradeBadge } from "./GradeBadge";
import { HeatmapPanel } from "./Heatmap";
import { KeysChips } from "./KeysChips";
import { PacksPanel } from "./PacksPanel";
import { useTipPlacement } from "../useTipPlacement";
import { PoolSeg } from "./PoolSeg";
import { TimeMachineBar } from "./TimeMachine";
import { MedalIcon } from "./Icons";
import { VisibilityMenu } from "./VisibilityMenu";
import { displayGrade, fmtNum } from "../format";
import {
  FC_LABELS,
  type Stats,
  GRADE_ORDER,
  type PoolMode,
  type Bucket,
  type SkillCurveBucket,
  type DistCounts,
  type Filters,
} from "../types";

const fmtK = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`;

/**
 * Position of a chart tooltip (fractions 0..1 of the container): anchored to the
 * point, but pulled inward near the edges so it never overflows (otherwise the
 * page gains a horizontal scrollbar).
 */
function tipPos(fx: number, fy: number): React.CSSProperties {
  const anchorX = fx < 0.25 ? "0%" : fx > 0.75 ? "-100%" : "-50%";
  // below the point across the whole upper half: a 6-line tooltip would
  // otherwise be cut off by the top edge of the panel
  const anchorY = fy < 0.55 ? "14px" : "calc(-100% - 14px)";
  return {
    left: `${(Math.min(Math.max(fx, 0.02), 0.98) * 100).toFixed(2)}%`,
    top: `${(fy * 100).toFixed(2)}%`,
    transform: `translate(${anchorX}, ${anchorY})`,
  };
}

/** One column of the rate histogram: a VERTICAL completion bar. */
function RateColumn({
  b,
  heightPct,
  label,
  gaugeHidden,
  countryLabel,
  onView,
}: {
  b: Stats["byRate"][number];
  heightPct: number;
  label: string;
  gaugeHidden: (id: string) => boolean;
  countryLabel: string;
  onView?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const { setWrap, tipRef, tipStyle, clearTip } = useTipPlacement(hover);
  // same rule as the completion bars: biggest layer first, the smaller ones
  // drawn on top of it, so every enabled gauge stays visible
  const layers = GAUGES.filter(
    (g) => !gaugeHidden(g.vis) && ((b as Record<string, number>)[g.id] ?? 0) > 0
  )
    .map((g) => ({ ...g, v: (b as Record<string, number>)[g.id] ?? 0 }))
    .sort((x, y) => y.v - x.v);
  const share = (v: number) => (b.played > 0 ? (v / b.played) * 100 : 0);
  return (
    <div
      ref={setWrap}
      className={`rate-col${hover ? " on" : ""}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        clearTip();
      }}
      onDoubleClick={onView}
    >
      <span className="rate-col-value">{b.played ? fmtNum(b.played) : ""}</span>
      <div className="rate-col-bar-wrap">
        {/* hovered: the bar unfolds to the full height of the chart. The
            layers below are shares of the BUCKET, not of the axis, so they
            stay exact — only the scale of the drawing changes. */}
        <div
          className="rate-col-bar"
          style={{ height: `${hover && b.played > 0 ? 100 : heightPct}%` }}
        >
          {layers.map((l) => (
            <div
              key={l.id}
              className="rate-col-layer"
              style={{ height: `${share(l.v)}%`, background: l.color }}
            />
          ))}
        </div>
      </div>
      <span className="rate-col-label">{label}x</span>
      {hover && b.played > 0 && (
        <div ref={tipRef} className="bar-tip" style={tipStyle}>
          <div className="bar-tip-row">
            <b className="bar-tip-title">{label}x</b>
            <b>{fmtNum(b.played)}</b>&nbsp;maps
          </div>
          {/* FIXED order (declaration order), independent from layer sizes */}
          {GAUGES.filter(
            (g) => !gaugeHidden(g.vis) && ((b as Record<string, number>)[g.id] ?? 0) > 0
          ).map((g) => {
            const v = (b as Record<string, number>)[g.id] ?? 0;
            return (
              <div key={g.id} className="bar-tip-row">
                <span className="gauge-dot" style={{ background: g.color }} />{" "}
                {g.id === "country" ? countryLabel : g.label} <b>{fmtNum(v)}</b>
                <span className="tip-dim"> ({share(v).toFixed(1)}%)</span>
                {g.id === "fc" && b.pfc > 0 && (
                  <span className="tip-dim"> · PFC {fmtNum(b.pfc)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Playback-rate histogram: how many maps have their BEST score at each rate
 * (0.1 buckets over lazer's 0.5x-2.0x range, 2.0x on its own). A rate belongs
 * to the SCORE, not to the map, so there is no "available maps" denominator
 * here — the bar height is the map count and the gauge layers are shares OF
 * that count.
 */
const RateHistogram = memo(function RateHistogram({
  rows,
  gaugeHidden,
  countryLabel = "#1",
  onViewRate,
}: {
  rows: Stats["byRate"];
  gaugeHidden: (id: string) => boolean;
  countryLabel?: string;
  onViewRate?: (min: number, max: number) => void;
}) {
  if (!rows.length) return null;
  // fixed 0.5x-2.0x axis: the empty buckets are information too (a gap at
  // 1.3x says something), and the axis stops moving between refreshes
  const LO = 5;
  const HI = 20;
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const empty = {
    played: 0, fc: 0, pfc: 0, nonfc: 0, ss: 0, gradeS: 0,
    gradeA: 0, gradeB: 0, gradeC: 0, gradeD: 0, country: 0,
    top1: 0, top8: 0, top15: 0, top25: 0, top50: 0, top100: 0, onem: 0,
  };
  const buckets: Stats["byRate"] = [];
  for (let b = LO; b <= HI; b++)
    buckets.push(byBucket.get(b) ?? { bucket: b, ...empty });
  const max = Math.max(...buckets.map((b) => b.played), 1);
  // Linear height, so the bars can be compared for what they are: the counts
  // span single digits to tens of thousands, which leaves the small buckets
  // as a sliver — hovering one grows it to full height (see RateColumn), and
  // that is where its gauge breakdown becomes readable.
  const height = (v: number) => (v <= 0 ? 0 : Math.max((v / max) * 100, 0.6));

  return (
    <div className="panel rate-panel">
      <h3>
        Maps by rate
        <span className="dim"> · hover a bar to unfold its gauges</span>
      </h3>
      <div className="rate-chart">
        {buckets.map((b) => (
          <RateColumn
            key={b.bucket}
            b={b}
            heightPct={height(b.played)}
            label={(b.bucket / 10).toFixed(1)}
            gaugeHidden={gaugeHidden}
            countryLabel={countryLabel}
            onView={() =>
              // [rate, rate+0.1), and the 2.0x bar is that exact rate. Rates
              // are stored rounded to 2 decimals, so the inclusive upper
              // bound of a bucket is simply x.x9 — computed on INTEGERS, or
              // the float noise leaked into the filter (1.0990000000000002).
              onViewRate?.(
                b.bucket / 10,
                b.bucket >= 20 ? 2 : (b.bucket * 10 + 9) / 100
              )
            }
          />
        ))}
      </div>
    </div>
  );
});

/**
 * Score curve: one step per band of the selected dimension (star rating by
 * default), y = median of the standardised bests in the band.
 */
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
const monthLabel = (q: number) =>
  `${2007 + Math.floor(q / 12)}-${String((q % 12) + 1).padStart(2, "0")}`;
const tenthBand = (q: number) =>
  q >= 100 ? "10" : `${(q / 10).toFixed(1)}\u2013${((q + 1) / 10).toFixed(1)}`;
const tenthView = (q: number, minKey: keyof Filters, maxKey: keyof Filters) =>
  ({
    [minKey]: String(q / 10),
    [maxKey]: q >= 100 ? "" : String(Math.round((q / 10 + 0.09999) * 100000) / 100000),
  }) as Partial<Filters>;
interface CurveDimCfg {
  label: string;
  tickEvery: number;
  tick: (q: number) => string;
  band: (q: number) => string;
  /** "cumulative missing" wording; null = open-ended last bucket ("all") */
  upTo: (q: number) => string | null;
  view: (q: number) => Partial<Filters>;
}
function curveDims(ruleset: number): Record<string, CurveDimCfg> {
  // one combo band per curve bucket; mania combos run far higher
  const comboStep = ruleset === 3 ? 60 : ruleset === 2 ? 25 : 20;
  const tenthDim = (label: string, minKey: keyof Filters, maxKey: keyof Filters): CurveDimCfg => ({
    label,
    tickEvery: 10,
    tick: (q) => `${label} ${q / 10}`,
    band: (q) => `${label} ${tenthBand(q)}`,
    upTo: (q) => (q >= 100 ? null : `${label} < ${((q + 1) / 10).toFixed(1)}`),
    view: (q) => tenthView(q, minKey, maxKey),
  });
  return {
    sr: {
      label: "Star rating",
      tickEvery: 10,
      tick: (q) => `${q / 10}\u2605`,
      band: (q) => (q >= 100 ? "10\u2605+" : `${tenthBand(q)}\u2605`),
      upTo: (q) => (q >= 100 ? null : `< ${((q + 1) / 10).toFixed(1)}\u2605`),
      view: (q) => tenthView(q, "srMin", "srMax"),
    },
    ar: tenthDim("AR", "arMin", "arMax"),
    od: tenthDim("OD", "odMin", "odMax"),
    cs:
      ruleset === 3
        ? {
            label: "Keys",
            tickEvery: 1,
            tick: (q) => `${q}K`,
            band: (q) => `${q}K`,
            upTo: (q) => `\u2264 ${q}K`,
            view: (q) => ({ csMin: String(q), csMax: String(q) }) as Partial<Filters>,
          }
        : tenthDim("CS", "csMin", "csMax"),
    hp: tenthDim("HP", "hpMin", "hpMax"),
    length: {
      label: "Length",
      tickEvery: 6,
      tick: (q) => mmss(q * 10),
      band: (q) => (q >= 60 ? "10:00+" : `${mmss(q * 10)}\u2013${mmss((q + 1) * 10)}`),
      upTo: (q) => (q >= 60 ? null : `< ${mmss((q + 1) * 10)}`),
      view: (q) =>
        ({ lenMin: String(q * 10), lenMax: q >= 60 ? "" : String((q + 1) * 10 - 1) }) as Partial<Filters>,
    },
    combo: {
      label: "Max combo",
      tickEvery: 10,
      tick: (q) => String(q * comboStep),
      band: (q) =>
        q >= 100
          ? `${100 * comboStep}x+`
          : `${q * comboStep}\u2013${(q + 1) * comboStep}x`,
      upTo: (q) => (q >= 100 ? null : `< ${(q + 1) * comboStep}x`),
      view: (q) =>
        ({
          comboMin: String(q * comboStep),
          comboMax: q >= 100 ? "" : String((q + 1) * comboStep - 1),
        }) as Partial<Filters>,
    },
    month: {
      label: "Ranked month",
      tickEvery: 12,
      tick: (q) => String(2007 + Math.floor(q / 12)),
      band: (q) => monthLabel(q),
      upTo: (q) => `\u2264 ${monthLabel(q)}`,
      view: (q) =>
        ({ rankedFrom: `${monthLabel(q)}-01`, rankedTo: `${monthLabel(q)}-31` }) as Partial<Filters>,
    },
  };
}

const SkillCurvePanel = memo(function SkillCurvePanel({
  ruleset = 0,
  pool = "all",
  keys = [],
  scope = "all",
  dim = "sr",
  onDim,
  pastBuckets = null,
  pastDay = null,
  onViewMaps,
}: {
  ruleset?: number;
  pool?: PoolMode;
  keys?: string[];
  scope?: DashScope;
  /** x-axis dimension: sr, ar, od, cs, hp, length, combo, month */
  dim?: string;
  onDim?: (d: string) => void;
  /** time machine: the curve RE-FITTED on the bests of that day (the live
   * curve would compare today's level against past scores) */
  pastBuckets?: SkillCurveBucket[] | null;
  pastDay?: string | null;
  /** double-click a band: open the Maps tab on it */
  onViewMaps?: (f: Partial<Filters>) => void;
}) {
  const prefs = useDisplayPrefs();
  const showWither = prefs.wither && ruleset === 0;
  const { data } = useQuery({
    queryKey: ["skill-curve", ruleset, pool, keys, scope, dim],
    queryFn: () => fetchSkillCurve(ruleset, pool, keys, scope, dim),
    refetchInterval: 60_000,
    enabled: pastBuckets == null, // the past comes from the snapshot
  });
  const [hover, setHover] = useState<SkillCurveBucket | null>(null);
  const DIMS = curveDims(ruleset);
  const cfg = DIMS[dim] ?? DIMS.sr;
  const buckets = pastBuckets ?? data?.buckets;
  const title = (
    <h3>
      Median score by {cfg.label.toLowerCase()}
      {pastDay && <span className="dim"> — as of {pastDay}</span>}
      {onDim && (
        <select
          className="curve-dim-select"
          value={dim}
          onChange={(e) => {
            setHover(null);
            onDim(e.target.value);
          }}
        >
          {Object.entries(DIMS).map(([k, d]) => (
            <option key={k} value={k}>
              {d.label}
            </option>
          ))}
        </select>
      )}
    </h3>
  );
  if (!buckets?.length) return <div className="panel curve-panel">{title}</div>;
  // cumulative missing = sum of missing across all bands <= this one
  const cumByQ = new Map<number, { classic: number; wither: number }>();
  let accC = 0;
  let accW = 0;
  for (const b of buckets) {
    accC += b.missingClassic;
    accW += b.missingWither;
    cumByQ.set(b.q, { classic: accC, wither: accW });
  }

  const W = 1000, H = 300, ML = 62, MR = 16, MT = 12, MB = 28;
  // A point is not a measure AT q, it is the value of the whole band
  // [q, q+1). The chart is drawn as steps for that reason.
  const xMin = buckets[0].q;
  const xMax = buckets[buckets.length - 1].q + 1;
  const x = (q: number) =>
    ML + ((q - xMin) / (xMax - xMin || 1)) * (W - ML - MR);

  // Hybrid scale: linear up to 1M std, then LOGARITHMIC above (modded bests
  // > 1M) — otherwise the modded plateau crushes the rest of the curve.
  const SPLIT = 1_000_000;
  const plotBot = H - MB;
  const plotH = plotBot - MT;
  const yDataMax = Math.max(...buckets.map((b) => b.predicted));
  const hasLog = yDataMax > SPLIT;
  const logMax = yDataMax * 1.03;
  const linFrac = hasLog ? 0.72 : 1; // height share for the 0..1M zone
  const y = (v: number) => {
    if (!hasLog || v <= SPLIT)
      return plotBot - (Math.min(v, SPLIT) / SPLIT) * plotH * linFrac;
    const t = Math.log(v / SPLIT) / Math.log(logMax / SPLIT);
    return plotBot - plotH * linFrac - t * plotH * (1 - linFrac);
  };

  const line = buckets
    .flatMap((b) => {
      const yy = y(b.predicted).toFixed(1);
      return [`${x(b.q).toFixed(1)},${yy}`, `${x(b.q + 1).toFixed(1)},${yy}`];
    })
    .join(" ");
  const area = `${x(xMin).toFixed(1)},${plotBot} ${line} ${x(xMax).toFixed(1)},${plotBot}`;
  const yTicks = [0, 250_000, 500_000, 750_000, SPLIT];
  if (hasLog) yTicks.push(Math.round(yDataMax));
  const xTicks: number[] = [];
  for (
    let q = Math.ceil(xMin / cfg.tickEvery) * cfg.tickEvery;
    q <= xMax;
    q += cfg.tickEvery
  )
    xTicks.push(q);
  const nBuckets = xMax - xMin;
  // light marking of the bands (dropped on dense axes like months)
  const xMinor: number[] = [];
  if (nBuckets <= 130)
    for (let q = xMin; q <= xMax; q++)
      if (q % cfg.tickEvery !== 0) xMinor.push(q);
  const bandW = (W - ML - MR) / (nBuckets || 1);

  return (
    <div className="panel curve-panel">
      {title}
      <div className="curve-chart">
        <svg viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="curve-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {xMinor.map((q) => (
            <line
              key={`m${q}`}
              x1={x(q)} x2={x(q)} y1={MT} y2={plotBot}
              stroke="var(--border)" strokeOpacity="0.3"
            />
          ))}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line
                x1={ML} x2={W - MR} y1={y(v)} y2={y(v)}
                stroke={v === SPLIT ? "var(--fg-dim)" : "var(--border)"}
                strokeOpacity={v === SPLIT ? 0.5 : 1}
                strokeDasharray={v === SPLIT ? undefined : "3 4"}
              />
              <text
                x={ML - 8} y={y(v) + 3} textAnchor="end"
                fill="var(--fg-dim)" fontSize="10"
              >
                {fmtK(v)}
              </text>
            </g>
          ))}
          {xTicks.map((q) => (
            <g key={`x${q}`}>
              <line
                x1={x(q)} x2={x(q)} y1={MT} y2={plotBot}
                stroke="var(--border)" strokeDasharray="3 4"
              />
              <text
                x={x(q)} y={H - 8} textAnchor="middle"
                fill="var(--fg-dim)" fontSize="10"
              >
                {cfg.tick(q)}
              </text>
            </g>
          ))}
          <polygon points={area} fill="url(#curve-fade)" />
          <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" />
          {/* hover by vertical band, aligned with the REAL band [q, q+1) */}
          {hover && (
            <rect
              x={x(hover.q)} y={MT}
              width={bandW} height={plotBot - MT}
              fill="var(--accent)" fillOpacity="0.09"
              pointerEvents="none"
            />
          )}
          {buckets.map((b) => (
            <rect
              key={`h${b.q}`}
              x={x(b.q)} y={MT}
              width={bandW} height={plotBot - MT}
              fill="transparent"
              style={onViewMaps ? { cursor: "pointer" } : undefined}
              onMouseEnter={() => setHover(b)}
              onDoubleClick={() => onViewMaps?.(cfg.view(b.q))}
            />
          ))}
        </svg>
        {hover && (
          <div
            className="curve-tip"
            style={tipPos(x(hover.q) / W, y(hover.predicted) / H)}
          >
            <b>{cfg.band(hover.q)}</b>{" "}
            Median: {fmtNum(hover.predicted)}
            {hover.raw == null ? " (carried over)" : ""}
            <br />
            {fmtNum(hover.played)}/{fmtNum(hover.total)}{" "}
            maps played
            <br />
            Missing:
            <br />
            - {fmtNum(hover.missingClassic)} Classic Score
            {showWither && (
              <>
                <br />- {fmtNum(hover.missingWither)} Wither Score
              </>
            )}
            <br />
            Cumulative missing ({cfg.upTo(hover.q) ?? "all"}):
            <br />
            - {fmtNum(cumByQ.get(hover.q)?.classic ?? 0)} Classic Score
            {showWither && (
              <>
                <br />- {fmtNum(cumByQ.get(hover.q)?.wither ?? 0)} Wither Score
              </>
            )}
          </div>
        )}
      </div>
      <small>
        one step per band = median of your standardised bests there ·
        missing stays measured on the star-rating curve · linear up to 1M,
        log above
      </small>
    </div>
  );
});

/**
 * Completion gauge. The yellow portion (country) is overlaid on the played
 * portion: it shows the share of country #1s out of the gauge total.
 */
/** Selectable completion gauges (one bar layer each). The legend groups them:
 * grades, global-top tiers (cumulative shades), country #1. */
export const GAUGES = [
  { id: "fc", vis: "fc", label: "FC / PFC", cls: "bar-fill-blue", color: "#5aa8f0", group: 0 },
  { id: "nonfc", vis: "nonfc", label: "non-FC", cls: "bar-fill-nonfc", color: "#8b90a8", group: 0 },
  // lazer's own grade colours (OsuColour.ForRank), best first
  { id: "ss", vis: "ss", label: "SS", cls: "bar-fill-ss", color: "#de31ae", group: 1 },
  { id: "gradeS", vis: "gradeS", label: "S", cls: "bar-fill-gs", color: "#02b5c3", group: 1 },
  { id: "gradeA", vis: "gradeA", label: "A", cls: "bar-fill-ga", color: "#88da20", group: 1 },
  { id: "gradeB", vis: "gradeB", label: "B", cls: "bar-fill-gb", color: "#e3b130", group: 1 },
  { id: "gradeC", vis: "gradeC", label: "C", cls: "bar-fill-gc", color: "#ff8e5d", group: 1 },
  { id: "gradeD", vis: "gradeD", label: "D", cls: "bar-fill-gd", color: "#ff5a5a", group: 1 },
  { id: "onem", vis: "onem", label: "1M", cls: "bar-fill-onem", color: "#f06ec8", group: 1, maniaOnly: true },
  // violet ramp: the old orange-to-red one collided with the B/C/D grades
  { id: "top1", vis: "top1", label: "Top 1", cls: "bar-fill-t1", color: "#9612e8", group: 2 },
  { id: "top8", vis: "top8", label: "Top 8", cls: "bar-fill-t8", color: "#7348dc", group: 2 },
  { id: "top15", vis: "top15", label: "Top 15", cls: "bar-fill-t15", color: "#8a67e2", group: 2 },
  { id: "top25", vis: "top25", label: "Top 25", cls: "bar-fill-t25", color: "#a186e8", group: 2 },
  { id: "top50", vis: "top50", label: "Top 50", cls: "bar-fill-t50", color: "#b8a5ee", group: 2 },
  { id: "top100", vis: "top100", label: "Top 100", cls: "bar-fill-t100", color: "#cfc4f3", group: 2 },
  { id: "country", vis: "country", label: "#1", cls: "bar-fill-gold", color: "#e8c84a", group: 3 },
] as const satisfies readonly {
  id: string; vis: string; label: string; cls: string; color: string;
  group: number; maniaOnly?: boolean;
}[];
export type GaugeId = (typeof GAUGES)[number]["id"];
export const GAUGES_HIDDEN_DEFAULT = [
  "nonfc", "gradeD", "gradeC", "gradeB", "gradeA", "gradeS", "ss",
  "top1", "top8", "top15", "top25", "top50", "top100",
];

function Bar({
  row,
  total,
  gaugeHidden,
  label,
  countryLabel = "#1",
}: {
  row: Partial<Record<GaugeId | "pfc", number | null>> & { played?: number | null };
  total: number;
  gaugeHidden: (id: string) => boolean;
  /** hovered-row name shown in the tooltip header ("2008", "4★–5★", "Ranked") */
  label?: string;
  /** "#1 FR" — tells the country first apart from the global Top 1 */
  countryLabel?: string;
}) {
  const played = row.played ?? 0;
  const pct = total > 0 ? (played / total) * 100 : 0;
  // visible layers, biggest first: each smaller gauge is drawn on top of the
  // previous one, so every enabled gauge stays visible whatever its value
  const layers = GAUGES.filter(
    (g) => !gaugeHidden(g.vis) && (row[g.id] ?? 0) > 0
  )
    .map((g) => ({ ...g, v: row[g.id] ?? 0 }))
    .sort((a, b) => b.v - a.v);
  // The bar itself only carries the main ratio — consistent whatever the
  // width (gauge counts used to overflow and vanish on narrow bars). The
  // full detail lives in a hover tooltip, one line per visible gauge.
  const [hover, setHover] = useState(false);
  const { setWrap, tipRef, tipStyle, clearTip } = useTipPlacement(hover);
  return (
    <div
      ref={setWrap}
      className="bar-wrap"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        clearTip();
      }}
    >
      <div className="bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
        {layers.map((l) => (
          <div
            key={l.id}
            className={`bar-fill ${l.cls}`}
            style={{ width: `${total > 0 ? (l.v / total) * 100 : 0}%` }}
          />
        ))}
        <span className="bar-label">
          {fmtNum(played)} / {fmtNum(total)} ({pct.toFixed(1)}%)
        </span>
      </div>
      {hover && (
        <div ref={tipRef} className="bar-tip" style={tipStyle}>
          <div className="bar-tip-row">
            {label && <b className="bar-tip-title">{label}</b>}
            <b>{fmtNum(played)} / {fmtNum(total)}</b>&nbsp;({pct.toFixed(1)}%)
          </div>
          {/* FIXED order (declaration order), independent from layer sizes */}
          {GAUGES.filter((g) => !gaugeHidden(g.vis) && (row[g.id] ?? 0) > 0).map((g) => (
            <div key={g.id} className="bar-tip-row">
              <span className="gauge-dot" style={{ background: g.color }} />{" "}
              {g.id === "country" ? countryLabel : g.label}{" "}
              <b>{fmtNum(row[g.id] ?? 0)}</b>
              {g.id === "fc" && (row.pfc ?? 0) > 0 && (
                <span className="tip-dim"> (PFC {fmtNum(row.pfc ?? 0)})</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Colored, clickable legend: teaches the color of each gauge AND toggles it.
 * Left-aligned, one cluster per family: grades | global tops | country #1. */
function GaugeLegend({
  isHidden,
  onToggle,
  ruleset = 0,
  countryLabel = "#1",
}: {
  isHidden: (id: string) => boolean;
  onToggle: (id: string) => void;
  ruleset?: number;
  countryLabel?: string;
}) {
  const groups = [0, 1, 2, 3].map((gr) =>
    GAUGES.filter(
      (g) => g.group === gr && (!("maniaOnly" in g) || ruleset === 3)
    )
  );
  return (
    <div className="gauge-legend">
      {groups.map((gs, i) => (
        <div key={i} className="gauge-group">
          {gs.map((g) => (
            <button
              key={g.vis}
              className={`chip gauge-chip${isHidden(g.vis) ? " off" : ""}`}
              onClick={() => onToggle(g.vis)}
              title={`${isHidden(g.vis) ? "Show" : "Hide"} the ${g.label} gauge`}
            >
              <span className="gauge-dot" style={{ background: g.color }} />
              {g.id === "country" ? countryLabel : g.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

interface DistRow {
  label: string;
  /** double-click: the Maps filters that select exactly this bucket */
  view?: Partial<Filters>;
  total: number;
  played: number | null;
  country?: number | null;
  fc?: number | null;
  pfc?: number | null;
  nonfc?: number | null;
  ss?: number | null;
  gradeS?: number | null;
  gradeA?: number | null;
  gradeB?: number | null;
  gradeC?: number | null;
  gradeD?: number | null;
  onem?: number | null;
  top1?: number | null;
  top8?: number | null;
  top15?: number | null;
  top25?: number | null;
  top50?: number | null;
  top100?: number | null;
}

const DistPanel = memo(function DistPanel({
  title,
  rows,
  gaugeHidden,
  countryLabel,
  onView,
}: {
  title: string;
  rows: DistRow[];
  gaugeHidden: (id: string) => boolean;
  countryLabel?: string;
  /** double-click a bar: list that bucket in the Maps tab */
  onView?: (f: Partial<Filters>) => void;
}) {
  return (
    <div className="panel">
      <h3>Completion by {title}</h3>
      {rows.map((r) => (
        <div
          key={r.label}
          className={`dist-row${r.view && onView ? " dist-row-view" : ""}`}
          onDoubleClick={r.view && onView ? () => onView(r.view!) : undefined}
        >
          <span className="dist-label">{r.label}</span>
          <Bar row={r} total={r.total} gaugeHidden={gaugeHidden} label={`${title} ${r.label}`} countryLabel={countryLabel} />
        </div>
      ))}
    </div>
  );
});

const statLabel = (b: number) => (b >= 10 ? "10" : `${b}–${b + 1}`);
/** mania key counts are exact integers, not ranges: 4K, 7K, 18K (dual stage) */
const keysLabel = (b: number) => `${b}K`;

export function Dashboard({
  ruleset = 0,
  pool = "all",
  onPoolChange,
  keys = [],
  onKeysChange,
  onViewPack,
  onViewRate,
  onViewBucket,
}: {
  ruleset?: number;
  /** map pool of the viewed ruleset — same choice as the Maps view */
  pool?: PoolMode;
  onPoolChange?: (pool: PoolMode) => void;
  /** mania key-count filter, shared with the Maps view */
  keys?: string[];
  onKeysChange?: (keys: string[]) => void;
  /** opens the Maps tab filtered on a pack (search token pack=TAG) */
  onViewPack?: (tag: string, scope: DashScope) => void;
  /** opens the Maps tab filtered on a star-rating range (max null = no cap),
   * carrying the dashboard's status scope so the list matches the curve */
  /** opens the Maps tab filtered on a playback-rate range */
  onViewRate?: (min: number, max: number, scope: DashScope) => void;
  /** opens the Maps tab on a completion-bar bucket (star rating, year, …) */
  onViewBucket?: (f: Partial<Filters>, scope: DashScope) => void;
}) {
  // witherscore is an osu!std-only proposal; everything else (time machine,
  // skill curve, missing) is per-ruleset
  const isStd = ruleset === 0;
  const country = useCountryCode();
  const prefs = useDisplayPrefs();
  const distHidden = useHidden("dashboard-dist");
  const gaugeHidden = useHidden(
    "dashboard-gauges",
    GAUGES_HIDDEN_DEFAULT,
    GAUGES.map((g) => g.vis)
  );
  // score-curve panel dimension, persisted; drives both the live fetch and
  // the snapshot reconstruction so the time machine follows the same axis
  const [curveDim, setCurveDimState] = useState<string>(
    () => localStorage.getItem("curve-dim") ?? "sr"
  );
  const setCurveDim = useCallback((d: string) => {
    setCurveDimState(d);
    localStorage.setItem("curve-dim", d);
  }, []);
  // "Ranked only" scope: the WHOLE dashboard drops loved maps (stats,
  // distributions, snapshot, skill curve) — persisted like the gauges
  const [scope, setScope] = useState<DashScope>(() => {
    const v = localStorage.getItem("dash-scope");
    return v === "ranked" || v === "loved" ? v : "all";
  });
  const setScopePersist = (v: DashScope) => {
    localStorage.setItem("dash-scope", v);
    setScope(v);
  };
  const { data, isLoading, error } = useQuery({
    queryKey: ["stats", ruleset, pool, keys, scope],
    queryFn: () => fetchStats(ruleset, pool, keys, scope),
    refetchInterval: 60_000,
  });
  // per ruleset AND pool: one shared key served osu!'s history to every tab
  const { data: timeline } = useQuery({
    queryKey: ["timeline", ruleset, pool, keys, scope],
    queryFn: () => fetchTimeline(ruleset, pool, keys, scope),
    refetchInterval: 5 * 60_000,
  });
  const [tmIdx, setTmIdx] = useState<number | null>(null);
  const tmDay =
    tmIdx != null && timeline && tmIdx < timeline.points.length - 1
      ? timeline.points[tmIdx].day
      : null;
  // Real-time snapshot fetching, "latest wins": at most ONE request in flight
  // (the endpoint answers in ~10-30 ms from an in-memory index); while it
  // runs, only the latest slider position is remembered and fired next. The
  // per-stat panels therefore track the slider with imperceptible latency,
  // without flooding the server with one request per tick.
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const inFlight = useRef(false);
  const pendingDay = useRef<string | null>(null);
  useEffect(() => {
    if (tmDay == null) {
      // keep the last snapshot: every consumer is gated on tmDay anyway, and
      // clearing it made each re-engage flash today's live data until the
      // first fetch of the new day landed
      pendingDay.current = null;
      return;
    }
    const run = (day: string) => {
      inFlight.current = true;
      fetchSnapshot(day, ruleset, pool, keys, scope, curveDim)
        .then((sn) => {
          inFlight.current = false;
          setSnap(sn);
          if (pendingDay.current && pendingDay.current !== day) {
            const next = pendingDay.current;
            pendingDay.current = null;
            run(next);
          } else {
            pendingDay.current = null;
          }
        })
        .catch(() => {
          inFlight.current = false;
          pendingDay.current = null;
        });
    };
    if (inFlight.current) pendingDay.current = tmDay;
    else run(tmDay);
  }, [tmDay, curveDim]);

  // Rate histogram rows: the snapshot replays the rate of the best held at
  // that date, so the panel follows the time machine like the others.
  const rateRows = useMemo<Stats["byRate"]>(() => {
    const live = data?.byRate ?? [];
    if (tmDay == null || snap == null) return live;
    return (snap.byRate ?? []).map((r) => ({
      bucket: Number(r.bucket),
      played: r.played,
      fc: r.fc,
      pfc: r.pfc ?? 0,
      nonfc: r.nonfc ?? 0,
      ss: r.ss ?? 0,
      gradeS: r.gradeS ?? 0,
      gradeA: r.gradeA ?? 0,
      gradeB: r.gradeB ?? 0,
      gradeC: r.gradeC ?? 0,
      gradeD: r.gradeD ?? 0,
      country: r.country,
      onem: r.onem ?? 0,
      top1: r.top1 ?? 0,
      top8: r.top8 ?? 0,
      top15: r.top15 ?? 0,
      top25: r.top25 ?? 0,
      top50: r.top50 ?? 0,
      top100: r.top100 ?? 0,
    }));
  }, [data, snap, tmDay != null]);

  // Per-stat panels: memoized so they do NOT re-render on every slider tick —
  // their rows only change when the (debounced) snapshot or live stats change.
  const dists = useMemo<{ title: string; rows: DistRow[] }[]>(() => {
    if (!data) return [];
    const isPast = tmDay != null;
    const useSnap = isPast && snap != null;
    const snapDict = (rows: SnapshotBucket[] | undefined) =>
      new Map((rows ?? []).map((r) => [String(r.bucket), r]));
    const snapOf = (dim: keyof Snapshot) =>
      useSnap ? snapDict(snap[dim] as SnapshotBucket[]) : null;
    const over = (
      dict: Map<string, SnapshotBucket> | null,
      key: string | number,
      live: Omit<DistRow, "label">
    ): Omit<DistRow, "label"> => {
      if (!dict) return live;
      const sv = dict.get(String(key));
      return {
        total: sv?.total ?? 0,
        played: sv?.played ?? 0,
        fc: sv?.fc ?? 0,
        country: sv?.country ?? 0,
        pfc: sv?.pfc ?? 0,
        nonfc: sv?.nonfc ?? 0,
        ss: sv?.ss ?? 0,
        gradeS: sv?.gradeS ?? 0,
        gradeA: sv?.gradeA ?? 0,
        gradeB: sv?.gradeB ?? 0,
        gradeC: sv?.gradeC ?? 0,
        gradeD: sv?.gradeD ?? 0,
        onem: sv?.onem ?? 0,
        // replayed from the global events (a position with no event is dated
        // at the best score that earned it)
        top1: sv?.top1 ?? 0,
        top8: sv?.top8 ?? 0,
        top15: sv?.top15 ?? 0,
        top25: sv?.top25 ?? 0,
        top50: sv?.top50 ?? 0,
        top100: sv?.top100 ?? 0,
      };
    };
    const liveOf = (b: DistCounts): Omit<DistRow, "label"> => ({
      total: b.total, played: b.played, country: b.country, fc: b.fc,
      pfc: b.pfc, nonfc: b.nonfc, ss: b.ss, gradeS: b.gradeS,
      gradeA: b.gradeA, gradeB: b.gradeB, gradeC: b.gradeC,
      gradeD: b.gradeD, onem: b.onem,
      top1: b.top1, top8: b.top8, top15: b.top15,
      top25: b.top25, top50: b.top50, top100: b.top100,
    });
    const bucketRows = (
      buckets: Bucket[],
      label: (b: number) => string,
      dict: Map<string, SnapshotBucket> | null,
      /** Maps filters selecting the bucket (double-click drill-down) */
      view?: (b: number) => Partial<Filters>
    ): DistRow[] =>
      buckets.map((b) => ({
        label: label(b.bucket),
        view: view?.(b.bucket),
        ...over(dict, b.bucket, liveOf(b)),
      }));
    // Every panel bucket maps back to a filter range. The server buckets by
    // truncation (CAST AS INTEGER), so a bucket is [b, b+1) — but the table
    // filters are inclusive, hence an upper bound a hair short of the next
    // bucket (same epsilon as the skill-curve drill-down). The capped last
    // bucket ("10★+", "2500+") simply drops its upper bound.
    const capped = (b: number, cap: number, lo: number, hi: number) =>
      b >= cap ? { min: String(lo), max: "" } : { min: String(lo), max: String(hi) };
    /** [b, b+1) expressed as an inclusive upper bound */
    const upTo = (b: number) => Math.round((b + 0.99999) * 100000) / 100000;
    return [
      {
        title: "star rating",
        rows: data.bySr.map((b) => ({
          label: b.sr >= 10 ? "10★+" : `${b.sr}★–${b.sr + 1}★`,
          view: {
            srMin: String(b.sr),
            srMax: b.sr >= 10 ? "" : String(upTo(b.sr)),
          },
          ...over(snapOf("bySr"), b.sr, liveOf(b)),
        })),
      },
      {
        title: "rank year",
        rows: data.byYear.map((b) => ({
          label: b.year,
          // the Maps tab filters on the ranked DATE; a full calendar year is
          // exactly what the panel buckets on
          view: { rankedFrom: `${b.year}-01-01`, rankedTo: `${b.year}-12-31` },
          ...over(snapOf("byYear"), b.year, liveOf(b)),
        })),
      },
      {
        title: "length",
        rows: bucketRows(
          data.byLen,
          (b) => (b >= 10 ? "10 min+" : `${b}–${b + 1} min`),
          snapOf("byLen"),
          // stored in seconds
          (b) => {
            const r = capped(b, 10, b * 60, (b + 1) * 60 - 1);
            return { lenMin: r.min, lenMax: r.max };
          }
        ),
      },
      {
        title: "max combo",
        rows: bucketRows(
          data.byCombo,
          (b) => (b >= 10 ? "2500+" : `${b * 250}–${(b + 1) * 250}`),
          snapOf("byCombo"),
          (b) => {
            const r = capped(b, 10, b * 250, (b + 1) * 250 - 1);
            return { comboMin: r.min, comboMax: r.max };
          }
        ),
      },
      ...(rulesetStatFields(ruleset).ar
        ? [
            {
              title: "AR",
              rows: bucketRows(data.byAr, statLabel, snapOf("byAr"), (b) => {
                const r = capped(b, 10, b, upTo(b));
                return { arMin: r.min, arMax: r.max };
              }),
            },
          ]
        : []),
      {
        title: "OD",
        rows: bucketRows(data.byOd, statLabel, snapOf("byOd"), (b) => {
          const r = capped(b, 10, b, upTo(b));
          return { odMin: r.min, odMax: r.max };
        }),
      },
      ...(rulesetStatFields(ruleset).cs
        ? [
            {
              title: rulesetStatFields(ruleset).csLabel,
              rows: bucketRows(
                data.byCs,
                ruleset === 3 ? keysLabel : statLabel,
                snapOf("byCs"),
                (b) => {
                  // mania: this dimension IS the key count, an exact integer,
                  // and its last bucket is 18K+ (dual-stage maps)
                  const r =
                    ruleset === 3
                      ? capped(b, 18, b, b)
                      : capped(b, 10, b, upTo(b));
                  return { csMin: r.min, csMax: r.max };
                }
              ),
            },
          ]
        : []),
      {
        title: "HP",
        rows: bucketRows(data.byHp, statLabel, snapOf("byHp"), (b) => {
          const r = capped(b, 10, b, upTo(b));
          return { hpMin: r.min, hpMax: r.max };
        }),
      },
    ];
  }, [data, snap, tmDay != null, ruleset]);

  // Drill-down from any completion bar. The dashboard's Ranked/Loved scope is
  // carried over (like the skill curve does) so the list holds exactly the
  // maps the bar counted; the hero bars pick their own status and win.
  // Stable identity: the DistPanel memos depend on it.
  // Every drill-down carries the dashboard's Ranked/Loved scope, so the Maps
  // list holds exactly what the panel counted. Wrapped in useCallback: the
  // panels below are memoized and a fresh arrow would re-render them all on
  // every slider tick.
  const viewRate = useCallback(
    (min: number, max: number) => onViewRate?.(min, max, scope),
    [onViewRate, scope]
  );
  const viewPack = useCallback(
    (tag: string) => onViewPack?.(tag, scope),
    [onViewPack, scope]
  );
  const viewBucket = useCallback(
    (f: Partial<Filters>) => onViewBucket?.(f, scope),
    [onViewBucket, scope]
  );

  if (isLoading)
    return (
      <div className="dashboard">
        <div className="panel">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="skeleton skeleton-line" />
          ))}
        </div>
      </div>
    );
  if (error || !data) return <div className="panel">Failed to load stats.</div>;

  // Time machine: when a past day is selected, the EXISTING hero counters
  // show that day's values (timeline lookup, instant). Panels that cannot be
  // reconstructed historically (missing score, PFC split, std/wither sums)
  // are dimmed instead.
  const points = timeline?.points ?? [];
  const past =
    tmIdx != null && points.length > 1 && tmIdx < points.length - 1
      ? points[tmIdx]
      : null;
  const t = data.totals;
  const eff = {
    total: past ? past.total : t.total,
    totalRanked: past ? past.totalRanked : t.ranked_total,
    totalLoved: past ? past.totalLoved : t.loved_total,
    played: past ? past.clears : t.played ?? 0,
    rankedPlayed: past ? past.clearsRanked : t.ranked_played ?? 0,
    lovedPlayed: past ? past.clearsLoved : t.loved_played ?? 0,
    fc: past ? past.fc : t.fc ?? 0,
    fcRanked: past ? past.fcRanked : t.fc_ranked ?? 0,
    fcLoved: past ? past.fcLoved : t.fc_loved ?? 0,
    country: past ? past.country : t.country_firsts ?? 0,
    countryRanked: past ? past.countryRanked : t.country_ranked ?? 0,
    countryLoved: past ? past.countryLoved : t.country_loved ?? 0,
    rankedClassic: past ? past.ranked : data.scoreSums.classic,
  };
  // Time machine: the snapshot re-fits the skill curve on the bests of that
  // date (comparing today's level to past scores would be meaningless) and
  // replays the FC states and leaderboard positions.
  const useSnapNow = past != null && snap != null;
  const missingNow = useSnapNow ? snap.missingSums : data.scoreSums;
  const scoreNow = useSnapNow ? snap.scoreSums : data.scoreSums;
  const fcNow = useSnapNow ? snap.fc : data.fc;
  const topsNow = useSnapNow ? snap.globalTops : data.globalTops;
  // hero gauge rows. In the past everything comes from the timeline point,
  // so the whole hero moves with the slider, no fetch involved: exact grades
  // from the per-status tier counts (silvers folded in), non-FC derived from
  // clears - FC, tops replayed from the rank events.
  const pastSt = (
    g: number[] | undefined,
    tops: number[] | undefined,
    clearsN: number,
    fcN: number,
    onem: number
  ) => ({
    nonfc: clearsN - fcN,
    ss: (g?.[6] ?? 0) + (g?.[7] ?? 0),
    gradeS: (g?.[4] ?? 0) + (g?.[5] ?? 0),
    gradeA: g?.[3] ?? 0,
    gradeB: g?.[2] ?? 0,
    gradeC: g?.[1] ?? 0,
    gradeD: g?.[0] ?? 0,
    onem,
    top1: tops?.[0] ?? 0,
    top8: tops?.[1] ?? 0,
    top15: tops?.[2] ?? 0,
    top25: tops?.[3] ?? 0,
    top50: tops?.[4] ?? 0,
    top100: tops?.[5] ?? 0,
  });
  const stRanked = past
    ? pastSt(past.gradesRanked, past.topsRanked, past.clearsRanked, past.fcRanked, past.onemRanked ?? 0)
    : data.byStatus?.find((b) => b.bucket === "ranked");
  const stLoved = past
    ? pastSt(past.gradesLoved, past.topsLoved, past.clearsLoved, past.fcLoved, past.onemLoved ?? 0)
    : data.byStatus?.find((b) => b.bucket === "loved");
  const sumSt = (k: keyof DistCounts) =>
    (((stRanked as unknown as Record<string, number | null>)?.[k]) ?? 0) +
    (((stLoved as unknown as Record<string, number | null>)?.[k]) ?? 0);
  const heroRow = (
    played: number, country: number, fc: number,
    st: typeof stRanked | { [k: string]: number } | undefined
  ) => ({
          played, country, fc,
          pfc: (st as DistCounts | undefined)?.pfc,
          nonfc: (st as DistCounts | undefined)?.nonfc,
          ss: (st as DistCounts | undefined)?.ss,
          gradeS: (st as DistCounts | undefined)?.gradeS,
          gradeA: (st as DistCounts | undefined)?.gradeA,
          gradeB: (st as DistCounts | undefined)?.gradeB,
          gradeC: (st as DistCounts | undefined)?.gradeC,
          gradeD: (st as DistCounts | undefined)?.gradeD,
          onem: (st as DistCounts | undefined)?.onem,
          top1: (st as DistCounts | undefined)?.top1,
          top8: (st as DistCounts | undefined)?.top8,
          top15: (st as DistCounts | undefined)?.top15,
          top25: (st as DistCounts | undefined)?.top25,
          top50: (st as DistCounts | undefined)?.top50,
          top100: (st as DistCounts | undefined)?.top100,
        });
  const heroGlobal = heroRow(eff.played, eff.country, eff.fc, {
    pfc: sumSt("pfc"), nonfc: sumSt("nonfc"), ss: sumSt("ss"),
    gradeS: sumSt("gradeS"), gradeA: sumSt("gradeA"), gradeB: sumSt("gradeB"),
    gradeC: sumSt("gradeC"), gradeD: sumSt("gradeD"), onem: sumSt("onem"),
    top1: sumSt("top1"), top8: sumSt("top8"), top15: sumSt("top15"),
    top25: sumSt("top25"), top50: sumSt("top50"), top100: sumSt("top100"),
  });
  const hero = (which: DashScope) =>
    onViewBucket
      ? () =>
          viewBucket({
            statuses:
              which === "ranked" ? ["1", "2"] : which === "loved" ? ["4"] : [],
          })
      : undefined;
  const heroRanked = heroRow(eff.rankedPlayed, eff.countryRanked, eff.fcRanked, stRanked);
  const heroLoved = heroRow(eff.lovedPlayed, eff.countryLoved, eff.fcLoved, stLoved);

  // timeline tiers are ordered D..XH; the grid shows XH..D
  const TIER_IDX: Record<string, number> = { D: 0, C: 1, B: 2, A: 3, S: 4, SH: 5, X: 6, XH: 7 };
  // all grades, zeros included (fixed 2x4 grid like the share card)
  const grades = GRADE_ORDER.map((g) => ({
    g,
    c: past ? past.grades[TIER_IDX[g]] ?? 0 : data.grades.find((x) => x.grade === g)?.c ?? 0,
  }));

  return (
    <div className="dashboard">
      <div className="sticky-head">
      <div className="dash-pool">
        <div className="seg">
          <button className={scope === "all" ? "active" : ""} onClick={() => setScopePersist("all")}>
            All
          </button>
          <button
            className={scope === "ranked" ? "active" : ""}
            title="Ranked/approved maps only, everywhere on this dashboard"
            onClick={() => setScopePersist("ranked")}
          >
            Ranked
          </button>
          <button
            className={scope === "loved" ? "active" : ""}
            title="Loved maps only, everywhere on this dashboard"
            onClick={() => setScopePersist("loved")}
          >
            Loved
          </button>
        </div>
        {!isStd && onPoolChange && <PoolSeg value={pool} onChange={onPoolChange} />}
        {ruleset === 3 && onKeysChange && (
          <KeysChips value={keys} onChange={onKeysChange} />
        )}
        {/* The gauges are drawn in the hero, every histogram, the rate columns
            and all their tooltips — the legend belongs with the scope, not
            above one grid it only appeared to control. Pushed right so the
            two families stay told apart on the same line. */}
        <GaugeLegend
          isHidden={gaugeHidden.isHidden}
          onToggle={gaugeHidden.toggle}
          ruleset={ruleset}
          countryLabel={firstPlaceLabel(country)}
        />
      </div>
      {points.length > 1 && (
        <TimeMachineBar points={points} idx={tmIdx} onChange={setTmIdx} />
      )}
      </div>
      {/* Hero: the essentials at a glance */}
      <div className="card hero">
        <div className="hero-bars">
          <h3>Completion</h3>
          {scope === "all" && (
            <div className={`dist-row${onViewBucket ? " dist-row-view" : ""}`} onDoubleClick={hero("all")}>
              <span className="dist-label">Global</span>
              <Bar row={heroGlobal} total={eff.total} gaugeHidden={gaugeHidden.isHidden} countryLabel={firstPlaceLabel(country)} label="Global" />
            </div>
          )}
          {scope !== "loved" && (
            <div className={`dist-row${onViewBucket ? " dist-row-view" : ""}`} onDoubleClick={hero("ranked")}>
              <span className="dist-label">Ranked</span>
              <Bar row={heroRanked} total={eff.totalRanked} gaugeHidden={gaugeHidden.isHidden} countryLabel={firstPlaceLabel(country)} label="Ranked" />
            </div>
          )}
          {scope !== "ranked" && (
            <div className={`dist-row${onViewBucket ? " dist-row-view" : ""}`} onDoubleClick={hero("loved")}>
              <span className="dist-label">Loved</span>
              <Bar row={heroLoved} total={eff.totalLoved} gaugeHidden={gaugeHidden.isHidden} countryLabel={firstPlaceLabel(country)} label="Loved" />
            </div>
          )}
        </div>
        <div className="hero-stat hero-country">
          <h3>{firstPlaceLabel(country)}</h3>
          <div className="hero-mid gold-text">{fmtNum(eff.country)}</div>
          {topsNow.checked > 0 && (
            <>
            <h3 className="hero-sub">Global tops</h3>
            <div className="global-tops">
              {(
                [
                  ["Top 1", topsNow.top1],
                  ["Top 8", topsNow.top8],
                  ["Top 15", topsNow.top15],
                  ["Top 25", topsNow.top25],
                  ["Top 50", topsNow.top50],
                  ["Top 100", topsNow.top100],
                ] as const
              ).map(([label, v]) => (
                <div key={label} className="grade-pill" title="Global leaderboard positions (cumulative)">
                  <b className="gt-label">{label}</b> {fmtNum(v)}
                </div>
              ))}
            </div>
            </>
          )}
          <small>out of {fmtNum(eff.played)} maps played</small>
        </div>
        <div className="hero-stat">
          <h3>Ranked score</h3>
          <div className="big">
            {fmtNum(useSnapNow ? scoreNow.classic : eff.rankedClassic)}{" "}
            <span className="big-unit">{ruleset === 3 ? "Score" : "Classic Score"}</span>
          </div>
          {prefs.wither && isStd && (
            <div className="big">
              {fmtNum(scoreNow.wither)} <span className="big-unit">Wither Score</span>
            </div>
          )}
          {ruleset !== 3 && (
            <small>Standardised: {fmtNum(scoreNow.lazer)}</small>
          )}
        </div>
        <div className="hero-stat">
          <h3>Missing score (estimate)</h3>
          <div className="big accent">
            {fmtNum(missingNow.missingClassic)}{" "}
            <span className="big-unit">{ruleset === 3 ? "Score" : "Classic Score"}</span>
          </div>
          {prefs.wither && isStd && (
            <div className="big accent">
              {fmtNum(missingNow.missingWither)}{" "}
              <span className="big-unit">Wither Score</span>
            </div>
          )}
          {ruleset !== 3 && (
            <small>Standardised: {fmtNum(missingNow.missing)}</small>
          )}
        </div>
        <div className="hero-stat hero-grades">
          <h3>Grades</h3>
          <div className="grade-grid">
            {grades.map(({ g, c }) => (
              <div key={g} className="grade-cell2">
                <GradeBadge grade={g} width={48} title={displayGrade(g)} />
                <span>{fmtNum(c)}</span>
              </div>
            ))}
          </div>
          <div className="grade-dist">
            {fcNow.map((f) => (
              <div key={f.fc_state} className="grade-pill">
                <b className={`fc fc-${f.fc_state}`}>{FC_LABELS[f.fc_state]}</b>{" "}
                {fmtNum(f.c)}
              </div>
            ))}
            {ruleset === 3 && (
              <div
                className="grade-pill"
                title="Maps with a perfect 1,000,000 play"
              >
                <b className="fc fc-0">1M</b> {fmtNum(data.oneMillions)}
              </div>
            )}
          </div>
        </div>
      </div>

      <HeatmapPanel cutoffDay={past?.day ?? null} ruleset={ruleset} pool={pool} keys={keys} scope={scope} />

      <div className="view-toolbar">
        <VisibilityMenu
          items={dists.map((d) => ({ id: d.title, label: `Completion by ${d.title}` }))}
          isHidden={distHidden.isHidden}
          onToggle={distHidden.toggle}
          label="Completion shown"
        />
      </div>
      <div className="dist-grid">
        {dists
          .filter((d) => !distHidden.isHidden(d.title))
          .map((d) => (
            <DistPanel
              key={d.title}
              title={d.title}
              rows={d.rows}
              gaugeHidden={gaugeHidden.isHidden}
              countryLabel={firstPlaceLabel(country)}
              onView={onViewBucket && viewBucket}
            />
          ))}
      </div>

      <RateHistogram
        rows={rateRows}
        gaugeHidden={gaugeHidden.isHidden}
        countryLabel={firstPlaceLabel(country)}
        onViewRate={onViewRate && viewRate}
      />

      <PacksPanel
        ruleset={ruleset}
        at={tmDay}
        pool={pool}
        keys={keys}
        scope={scope}
        onViewPack={onViewPack && viewPack}
      />

      <SkillCurvePanel
        ruleset={ruleset}
        pool={pool}
        keys={keys}
        scope={scope}
        dim={curveDim}
        onDim={setCurveDim}
        pastBuckets={useSnapNow ? snap.curve : null}
        pastDay={useSnapNow ? snap.day : null}
        onViewMaps={onViewBucket && viewBucket}
      />
    </div>
  );
}
