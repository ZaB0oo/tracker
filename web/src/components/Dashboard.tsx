import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { PoolSeg } from "./PoolSeg";
import { TimeMachineBar } from "./TimeMachine";
import { MedalIcon } from "./Icons";
import { VisibilityMenu } from "./VisibilityMenu";
import { displayGrade, fmtNum } from "../format";
import {
  FC_LABELS,
  GRADE_ORDER,
  type PoolMode,
  type Bucket,
  type SkillCurveBucket,
  type DistCounts,
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

/**
 * Skill curve (basis of "missing"): x-axis star rating, y-axis predicted
 * standardised score, one point per 0.1★ band, details on hover.
 */
const SkillCurvePanel = memo(function SkillCurvePanel({
  ruleset = 0,
  pool = "all",
  keys = [],
  scope = "all",
  pastBuckets = null,
  pastDay = null,
  onViewSr,
}: {
  ruleset?: number;
  pool?: PoolMode;
  keys?: string[];
  scope?: DashScope;
  /** time machine: the curve RE-FITTED on the bests of that day (the live
   * curve would compare today's level against past scores) */
  pastBuckets?: SkillCurveBucket[] | null;
  pastDay?: string | null;
  /** double-click a point: open the Maps tab on that 0.1★ slice (max null =
   * the open-ended 10★+ bucket) */
  onViewSr?: (min: number, max: number | null) => void;
}) {
  const prefs = useDisplayPrefs();
  const showWither = prefs.wither && ruleset === 0;
  const { data } = useQuery({
    queryKey: ["skill-curve", ruleset, pool, keys, scope],
    queryFn: () => fetchSkillCurve(ruleset, pool, keys, scope),
    refetchInterval: 60_000,
    enabled: pastBuckets == null, // the past comes from the snapshot
  });
  const [hover, setHover] = useState<SkillCurveBucket | null>(null);
  const buckets = pastBuckets ?? data?.buckets;
  if (!buckets?.length) return null;
  // cumulative missing = sum of missing across all bands <= this one
  const cumByQ = new Map<number, { classic: number; wither: number }>();
  let accC = 0;
  let accW = 0;
  for (const b of buckets) {
    accC += b.missingClassic;
    accW += b.missingWither;
    cumByQ.set(b.sr, { classic: accC, wither: accW });
  }

  const W = 1000, H = 300, ML = 62, MR = 16, MT = 12, MB = 28;
  const xMin = Math.floor(Math.min(...buckets.map((b) => b.sr)));
  const xMax = Math.ceil(Math.max(...buckets.map((b) => b.sr)) * 10) / 10;
  const x = (sr: number) =>
    ML + ((sr - xMin) / (xMax - xMin || 1)) * (W - ML - MR);

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
    .map((b) => `${x(b.sr).toFixed(1)},${y(b.predicted).toFixed(1)}`)
    .join(" ");
  const area = `${x(buckets[0].sr).toFixed(1)},${plotBot} ${line} ${x(
    buckets[buckets.length - 1].sr
  ).toFixed(1)},${plotBot}`;
  const yTicks = [0, 250_000, 500_000, 750_000, SPLIT];
  if (hasLog) yTicks.push(Math.round(yDataMax));
  const xTicks: number[] = [];
  for (let sr = xMin; sr <= xMax; sr++) xTicks.push(sr);
  // light marking of the 0.1★ bands (excluding whole-number ticks)
  const xMinor: number[] = [];
  for (let q = Math.round(xMin * 10); q <= Math.round(xMax * 10); q++)
    if (q % 10 !== 0) xMinor.push(q / 10);
  // width of a 0.1★ band in px (vertical hover zone)
  const bandW = (W - ML - MR) / ((xMax - xMin) * 10 || 1);

  return (
    <div className="panel curve-panel">
      <h3>
        Predicted reachable score by star rating (estimate)
        {pastDay && <span className="dim"> — as of {pastDay}</span>}
      </h3>
      <div className="curve-chart">
        <svg viewBox={`0 0 ${W} ${H}`} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id="curve-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {xMinor.map((sr) => (
            <line
              key={`m${sr}`}
              x1={x(sr)} x2={x(sr)} y1={MT} y2={plotBot}
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
          {xTicks.map((sr) => (
            <g key={`x${sr}`}>
              <line
                x1={x(sr)} x2={x(sr)} y1={MT} y2={plotBot}
                stroke="var(--border)" strokeDasharray="3 4"
              />
              <text
                x={x(sr)} y={H - 8} textAnchor="middle"
                fill="var(--fg-dim)" fontSize="10"
              >
                {sr}★
              </text>
            </g>
          ))}
          <polygon points={area} fill="url(#curve-fade)" />
          <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" />
          {buckets.map((b) => (
            <circle
              key={`p${b.sr}`}
              cx={x(b.sr)} cy={y(b.predicted)}
              r={hover?.sr === b.sr ? 4 : 2}
              fill={b.inherited ? "var(--bg2)" : "var(--accent)"}
              stroke="var(--accent)" strokeWidth="1.2"
            />
          ))}
          {/* hover by vertical band, aligned with the REAL slice [sr, sr+0.1)
              — the point sits on the slice's lower bound */}
          {hover && (
            <rect
              x={x(hover.sr)} y={MT}
              width={bandW} height={plotBot - MT}
              fill="var(--accent)" fillOpacity="0.09"
              pointerEvents="none"
            />
          )}
          {buckets.map((b) => (
            <rect
              key={`h${b.sr}`}
              x={x(b.sr)} y={MT}
              width={bandW} height={plotBot - MT}
              fill="transparent"
              style={onViewSr ? { cursor: "pointer" } : undefined}
              onMouseEnter={() => setHover(b)}
              onDoubleClick={() =>
                // slice [sr, sr+0.1). The table filter is inclusive, so the
                // upper bound sits just under the next slice — and the LAST
                // point is the "10★+" bucket: no upper bound at all there.
                onViewSr?.(
                  b.sr,
                  b.sr >= 10 ? null : Math.round((b.sr + 0.09999) * 100000) / 100000
                )
              }
            >
              {onViewSr && <title>Double-click: show these maps in the Maps tab</title>}
            </rect>
          ))}
        </svg>
        {hover && (
          <div
            className="curve-tip"
            style={tipPos(x(hover.sr) / W, y(hover.predicted) / H)}
          >
            <b>
              {hover.sr >= 10
                ? "10★+"
                : `${hover.sr.toFixed(1)}–${(hover.sr + 0.1).toFixed(1)}★`}
            </b>{" "}
            Prediction: {fmtNum(hover.predicted)}
            {hover.inherited ? " (inherited)" : ""}
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
            Cumulative missing (
            {hover.sr >= 10 ? "all" : `< ${(hover.sr + 0.1).toFixed(1)}★`}):
            <br />
            - {fmtNum(cumByQ.get(hover.sr)?.classic ?? 0)} Classic Score
            {showWither && (
              <>
                <br />- {fmtNum(cumByQ.get(hover.sr)?.wither ?? 0)} Wither Score
              </>
            )}
          </div>
        )}
      </div>
      <small>
        one point per 0.1★ band · prediction = median of your standardised
        bests in the band (hollow point = « inherited »: fewer than 5 bests,
        value carried over from the previous band) · missing = sum of the
        realistic missing of the band's maps, unplayed included · cumulative
        missing = total of all bands up to this one · linear scale up to 1M,
        logarithmic above
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
  { id: "splus", vis: "splus", label: "S+", cls: "bar-fill-splus", color: "#4fd0b0", group: 0 },
  { id: "ss", vis: "ss", label: "SS", cls: "bar-fill-ss", color: "#e8e8f5", group: 0 },
  { id: "onem", vis: "onem", label: "1M", cls: "bar-fill-onem", color: "#f06ec8", group: 0, maniaOnly: true },
  { id: "top100", vis: "top100", label: "Top 100", cls: "bar-fill-t100", color: "#f0a45a", group: 1 },
  { id: "top50", vis: "top50", label: "Top 50", cls: "bar-fill-t50", color: "#e88a3e", group: 1 },
  { id: "top25", vis: "top25", label: "Top 25", cls: "bar-fill-t25", color: "#dd6e2c", group: 1 },
  { id: "top15", vis: "top15", label: "Top 15", cls: "bar-fill-t15", color: "#d0541f", group: 1 },
  { id: "top8", vis: "top8", label: "Top 8", cls: "bar-fill-t8", color: "#c23a18", group: 1 },
  { id: "top1", vis: "top1", label: "Top 1", cls: "bar-fill-t1", color: "#ff4d4d", group: 1 },
  { id: "country", vis: "country", label: "#1", cls: "bar-fill-gold", color: "#e8c84a", group: 2 },
] as const satisfies readonly {
  id: string; vis: string; label: string; cls: string; color: string;
  group: number; maniaOnly?: boolean;
}[];
export type GaugeId = (typeof GAUGES)[number]["id"];
export const GAUGES_HIDDEN_DEFAULT = [
  "splus", "ss", "top1", "top8", "top15", "top25", "top50", "top100",
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
  // Real measurement instead of a guess: the tooltip is rendered fixed, then
  // placed above the bar if its ACTUAL height fits the viewport, else below,
  // clamped horizontally — it can never overflow anything again.
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipStyle, setTipStyle] = useState<React.CSSProperties>();
  useLayoutEffect(() => {
    if (!hover || !tipRef.current || !wrapRef.current) return;
    const bar = wrapRef.current.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    const above = bar.top - tip.height - 7;
    const top = above >= 8 ? above : bar.bottom + 7;
    const left = Math.max(
      8,
      Math.min(bar.left + bar.width / 2 - tip.width / 2, window.innerWidth - tip.width - 8)
    );
    setTipStyle({ position: "fixed", top, left, bottom: "auto", transform: "none" });
  }, [hover]);
  return (
    <div
      ref={wrapRef}
      className="bar-wrap"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setTipStyle(undefined);
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
  const groups = [0, 1, 2].map((gr) =>
    GAUGES.filter(
      (g) => g.group === gr && (!("maniaOnly" in g) || ruleset === 3)
    )
  );
  const titles = ["Grades", "Global tops", "Country"];
  return (
    <div className="gauge-legend">
      {groups.map((gs, i) => (
        <div key={i} className="gauge-group">
          <span className="gauge-group-title">{titles[i]}</span>
          {gs.map((g) => (
            <button
              key={g.vis}
              className={`gauge-chip${isHidden(g.vis) ? " off" : ""}`}
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
  total: number;
  played: number | null;
  country?: number | null;
  fc?: number | null;
  pfc?: number | null;
  ss?: number | null;
  splus?: number | null;
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
}: {
  title: string;
  rows: DistRow[];
  gaugeHidden: (id: string) => boolean;
  countryLabel?: string;
}) {
  return (
    <div className="panel">
      <h3>Completion by {title}</h3>
      {rows.map((r) => (
        <div key={r.label} className="dist-row">
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
  onViewSr,
}: {
  ruleset?: number;
  /** map pool of the viewed ruleset — same choice as the Maps view */
  pool?: PoolMode;
  onPoolChange?: (pool: PoolMode) => void;
  /** mania key-count filter, shared with the Maps view */
  keys?: string[];
  onKeysChange?: (keys: string[]) => void;
  /** opens the Maps tab filtered on a pack (search token pack=TAG) */
  onViewPack?: (tag: string) => void;
  /** opens the Maps tab filtered on a star-rating range (max null = no cap),
   * carrying the dashboard's status scope so the list matches the curve */
  onViewSr?: (min: number, max: number | null, scope: DashScope) => void;
}) {
  // witherscore is an osu!std-only proposal; everything else (time machine,
  // skill curve, missing) is per-ruleset
  const isStd = ruleset === 0;
  const country = useCountryCode();
  const prefs = useDisplayPrefs();
  const distHidden = useHidden("dashboard-dist");
  const gaugeHidden = useHidden("dashboard-gauges", GAUGES_HIDDEN_DEFAULT);
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
      setSnap(null);
      pendingDay.current = null;
      return;
    }
    const run = (day: string) => {
      inFlight.current = true;
      fetchSnapshot(day, ruleset, pool, keys, scope)
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
  }, [tmDay]);

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
        ss: sv?.ss ?? 0,
        splus: sv?.splus ?? 0,
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
      pfc: b.pfc, ss: b.ss, splus: b.splus, onem: b.onem,
      top1: b.top1, top8: b.top8, top15: b.top15,
      top25: b.top25, top50: b.top50, top100: b.top100,
    });
    const bucketRows = (
      buckets: Bucket[],
      label: (b: number) => string,
      dict: Map<string, SnapshotBucket> | null
    ): DistRow[] =>
      buckets.map((b) => ({
        label: label(b.bucket),
        ...over(dict, b.bucket, liveOf(b)),
      }));
    return [
      {
        title: "star rating",
        rows: data.bySr.map((b) => ({
          label: b.sr >= 10 ? "10★+" : `${b.sr}★–${b.sr + 1}★`,
          ...over(snapOf("bySr"), b.sr, liveOf(b)),
        })),
      },
      {
        title: "rank year",
        rows: data.byYear.map((b) => ({
          label: b.year,
          ...over(snapOf("byYear"), b.year, liveOf(b)),
        })),
      },
      {
        title: "length",
        rows: bucketRows(data.byLen, (b) => (b >= 10 ? "10 min+" : `${b}–${b + 1} min`), snapOf("byLen")),
      },
      {
        title: "max combo",
        rows: bucketRows(
          data.byCombo,
          (b) => (b >= 10 ? "2500+" : `${b * 250}–${(b + 1) * 250}`),
          snapOf("byCombo")
        ),
      },
      ...(rulesetStatFields(ruleset).ar
        ? [{ title: "AR", rows: bucketRows(data.byAr, statLabel, snapOf("byAr")) }]
        : []),
      { title: "OD", rows: bucketRows(data.byOd, statLabel, snapOf("byOd")) },
      ...(rulesetStatFields(ruleset).cs
        ? [
            {
              title: rulesetStatFields(ruleset).csLabel,
              rows: bucketRows(
                data.byCs,
                ruleset === 3 ? keysLabel : statLabel,
                snapOf("byCs")
              ),
            },
          ]
        : []),
      { title: "HP", rows: bucketRows(data.byHp, statLabel, snapOf("byHp")) },
    ];
  }, [data, snap, tmDay != null, ruleset]);

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
  // hero gauge rows: live per-status aggregates; in the past only the
  // reconstructed ones exist (handled by the dists, the hero keeps FC/#1)
  const stRanked = data.byStatus?.find((b) => b.bucket === "ranked");
  const stLoved = data.byStatus?.find((b) => b.bucket === "loved");
  const sumSt = (k: keyof DistCounts) =>
    ((stRanked?.[k] as number) ?? 0) + ((stLoved?.[k] as number) ?? 0);
  const heroRow = (
    played: number, country: number, fc: number,
    st: typeof stRanked | { [k: string]: number } | undefined
  ) =>
    past
      ? { played, country, fc }
      : {
          played, country, fc,
          pfc: (st as DistCounts | undefined)?.pfc,
          ss: (st as DistCounts | undefined)?.ss,
          splus: (st as DistCounts | undefined)?.splus,
          onem: (st as DistCounts | undefined)?.onem,
          top1: (st as DistCounts | undefined)?.top1,
          top8: (st as DistCounts | undefined)?.top8,
          top15: (st as DistCounts | undefined)?.top15,
          top25: (st as DistCounts | undefined)?.top25,
          top50: (st as DistCounts | undefined)?.top50,
          top100: (st as DistCounts | undefined)?.top100,
        };
  const heroGlobal = heroRow(eff.played, eff.country, eff.fc, {
    pfc: sumSt("pfc"), ss: sumSt("ss"), splus: sumSt("splus"), onem: sumSt("onem"),
    top1: sumSt("top1"), top8: sumSt("top8"), top15: sumSt("top15"),
    top25: sumSt("top25"), top50: sumSt("top50"), top100: sumSt("top100"),
  });
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
      </div>
      {points.length > 1 && (
        <TimeMachineBar points={points} idx={tmIdx} onChange={setTmIdx} />
      )}
      {/* Hero: the essentials at a glance */}
      <div className="card hero">
        <div className="hero-bars">
          <h3>Completion</h3>
          {scope === "all" && (
            <div className="dist-row">
              <span className="dist-label">Global</span>
              <Bar row={heroGlobal} total={eff.total} gaugeHidden={gaugeHidden.isHidden} countryLabel={firstPlaceLabel(country)} label="Global" />
            </div>
          )}
          {scope !== "loved" && (
            <div className="dist-row">
              <span className="dist-label">Ranked</span>
              <Bar row={heroRanked} total={eff.totalRanked} gaugeHidden={gaugeHidden.isHidden} countryLabel={firstPlaceLabel(country)} label="Ranked" />
            </div>
          )}
          {scope !== "ranked" && (
            <div className="dist-row">
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
        <GaugeLegend
          isHidden={gaugeHidden.isHidden}
          onToggle={gaugeHidden.toggle}
          ruleset={ruleset}
          countryLabel={firstPlaceLabel(country)}
        />
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
            <DistPanel key={d.title} title={d.title} rows={d.rows} gaugeHidden={gaugeHidden.isHidden} countryLabel={firstPlaceLabel(country)} />
          ))}
      </div>

      <PacksPanel
        ruleset={ruleset}
        at={tmDay}
        pool={pool}
        keys={keys}
        scope={scope}
        onViewPack={onViewPack}
      />

      <SkillCurvePanel
        ruleset={ruleset}
        pool={pool}
        keys={keys}
        scope={scope}
        pastBuckets={useSnapNow ? snap.curve : null}
        pastDay={useSnapNow ? snap.day : null}
        onViewSr={
          onViewSr && ((min, max) => onViewSr(min, max, scope))
        }
      />
    </div>
  );
}
