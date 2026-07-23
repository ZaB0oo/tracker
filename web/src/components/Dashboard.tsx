import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSkillCurve, fetchSnapshot, fetchStats, fetchTimeline, type Snapshot, type SnapshotBucket } from "../api";
import { firstPlaceLabel, useCountryCode } from "../country";
import { useDisplayPrefs } from "../prefs";
import { useHidden } from "../visibility";
import { GradeBadge } from "./GradeBadge";
import { HeatmapPanel } from "./Heatmap";
import { TimeMachineBar } from "./TimeMachine";
import { MedalIcon } from "./Icons";
import { VisibilityMenu } from "./VisibilityMenu";
import { displayGrade, fmtNum } from "../format";
import {
  FC_LABELS,
  type Bucket,
  type SkillCurveBucket,
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
function SkillCurvePanel() {
  const prefs = useDisplayPrefs();
  const { data } = useQuery({
    queryKey: ["skill-curve"],
    queryFn: fetchSkillCurve,
    refetchInterval: 60_000,
  });
  const [hover, setHover] = useState<SkillCurveBucket | null>(null);
  if (!data?.buckets?.length) return null;
  const buckets = data.buckets;
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
      <h3>Predicted reachable score by star rating (estimate)</h3>
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
          {/* hover by vertical band: the whole column triggers the tooltip */}
          {hover && (
            <rect
              x={x(hover.sr) - bandW / 2} y={MT}
              width={bandW} height={plotBot - MT}
              fill="var(--accent)" fillOpacity="0.09"
              pointerEvents="none"
            />
          )}
          {buckets.map((b) => (
            <rect
              key={`h${b.sr}`}
              x={x(b.sr) - bandW / 2} y={MT}
              width={bandW} height={plotBot - MT}
              fill="transparent"
              onMouseEnter={() => setHover(b)}
            />
          ))}
        </svg>
        {hover && (
          <div
            className="curve-tip"
            style={tipPos(x(hover.sr) / W, y(hover.predicted) / H)}
          >
            <b>{hover.sr.toFixed(1)}★</b> Prediction: {fmtNum(hover.predicted)}
            {hover.inherited ? " (inherited)" : ""}
            <br />
            {fmtNum(hover.played)}/{fmtNum(hover.total)}{" "}
            maps played
            <br />
            Missing:
            <br />
            - {fmtNum(hover.missingClassic)} Classic Score
            {prefs.wither && (
              <>
                <br />- {fmtNum(hover.missingWither)} Wither Score
              </>
            )}
            <br />
            Cumulative missing (≤ {hover.sr.toFixed(1)}★):
            <br />
            - {fmtNum(cumByQ.get(hover.sr)?.classic ?? 0)} Classic Score
            {prefs.wither && (
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
}

/**
 * Completion gauge. The yellow portion (country) is overlaid on the played
 * portion: it shows the share of country #1s out of the gauge total.
 */
function Bar({
  played,
  total,
  country = 0,
  fc = 0,
}: {
  played: number;
  total: number;
  country?: number;
  fc?: number;
}) {
  const pct = total > 0 ? (played / total) * 100 : 0;
  const fcPct = total > 0 ? (fc / total) * 100 : 0;
  const countryPct = total > 0 ? (country / total) * 100 : 0;
  const done = total > 0 && played >= total;
  return (
    <div className="bar">
      <div className="bar-fill" style={{ width: `${pct}%` }} />
      {fc > 0 && (
        <div className="bar-fill bar-fill-blue" style={{ width: `${fcPct}%` }} />
      )}
      {country > 0 && (
        <div className="bar-fill bar-fill-gold" style={{ width: `${countryPct}%` }} />
      )}
      <span className="bar-label">
        {fmtNum(played)} / {fmtNum(total)} ({pct.toFixed(1)}%)
        {fc > 0 ? ` · FC ${fmtNum(fc)}` : ""}
        {country > 0 && (
          <>
            {" · "}
            <MedalIcon width={12} /> {fmtNum(country)}
          </>
        )}
      </span>
      {done && <span className="bar-check">✓</span>}
    </div>
  );
}

interface DistRow {
  label: string;
  total: number;
  played: number | null;
  country?: number | null;
  fc?: number | null;
}

const DistPanel = memo(function DistPanel({ title, rows }: { title: string; rows: DistRow[] }) {
  return (
    <div className="panel">
      <h3>Completion by {title}</h3>
      {rows.map((r) => (
        <div key={r.label} className="dist-row">
          <span className="dist-label">{r.label}</span>
          <Bar
            played={r.played ?? 0}
            total={r.total}
            country={r.country ?? 0}
            fc={r.fc ?? 0}
          />
        </div>
      ))}
    </div>
  );
});

const statLabel = (b: number) => (b >= 10 ? "10" : `${b}–${b + 1}`);

export function Dashboard() {
  const country = useCountryCode();
  const prefs = useDisplayPrefs();
  const distHidden = useHidden("dashboard-dist");
  const { data, isLoading, error } = useQuery({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: 60_000,
  });
  const { data: timeline } = useQuery({
    queryKey: ["timeline"],
    queryFn: fetchTimeline,
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
      fetchSnapshot(day)
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
      live: { total: number; played: number | null; fc: number | null; country: number | null }
    ) => {
      if (!dict) return live;
      const sv = dict.get(String(key));
      return {
        total: sv?.total ?? 0,
        played: sv?.played ?? 0,
        fc: sv?.fc ?? 0,
        country: sv?.country ?? 0,
      };
    };
    const bucketRows = (
      buckets: Bucket[],
      label: (b: number) => string,
      dict: Map<string, SnapshotBucket> | null
    ): DistRow[] =>
      buckets.map((b) => ({
        label: label(b.bucket),
        ...over(dict, b.bucket, { total: b.total, played: b.played, country: b.country, fc: b.fc }),
      }));
    return [
      {
        title: "star rating",
        rows: data.bySr.map((b) => ({
          label: b.sr >= 10 ? "10★+" : `${b.sr}★–${b.sr + 1}★`,
          ...over(snapOf("bySr"), b.sr, { total: b.total, played: b.played, country: b.country, fc: b.fc }),
        })),
      },
      {
        title: "rank year",
        rows: data.byYear.map((b) => ({
          label: b.year,
          ...over(snapOf("byYear"), b.year, { total: b.total, played: b.played, country: b.country, fc: b.fc }),
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
          (b) => (b >= 8 ? "2000+" : `${b * 250}–${(b + 1) * 250}`),
          snapOf("byCombo")
        ),
      },
      { title: "AR", rows: bucketRows(data.byAr, statLabel, snapOf("byAr")) },
      { title: "OD", rows: bucketRows(data.byOd, statLabel, snapOf("byOd")) },
      { title: "CS", rows: bucketRows(data.byCs, statLabel, snapOf("byCs")) },
      { title: "HP", rows: bucketRows(data.byHp, statLabel, snapOf("byHp")) },
    ];
  }, [data, snap, tmDay != null]);

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

  const gradeOrder = ["XH", "X", "SH", "S", "A", "B", "C", "D"];
  // timeline tiers are ordered D..XH; the grid shows XH..D
  const TIER_IDX: Record<string, number> = { D: 0, C: 1, B: 2, A: 3, S: 4, SH: 5, X: 6, XH: 7 };
  // all grades, zeros included (fixed 2x4 grid like the share card)
  const grades = gradeOrder.map((g) => ({
    g,
    c: past ? past.grades[TIER_IDX[g]] ?? 0 : data.grades.find((x) => x.grade === g)?.c ?? 0,
  }));

  return (
    <div className="dashboard">
      {points.length > 1 && (
        <TimeMachineBar points={points} idx={tmIdx} onChange={setTmIdx} />
      )}
      {/* Hero: the essentials at a glance */}
      <div className="card hero">
        <div className="hero-bars">
          <h3>Completion</h3>
          <div className="dist-row">
            <span className="dist-label">Global</span>
            <Bar
              played={eff.played}
              total={eff.total}
              country={eff.country}
              fc={eff.fc}
            />
          </div>
          <div className="dist-row">
            <span className="dist-label">Ranked</span>
            <Bar
              played={eff.rankedPlayed}
              total={eff.totalRanked}
              country={eff.countryRanked}
              fc={eff.fcRanked}
            />
          </div>
          <div className="dist-row">
            <span className="dist-label">Loved</span>
            <Bar
              played={eff.lovedPlayed}
              total={eff.totalLoved}
              country={eff.countryLoved}
              fc={eff.fcLoved}
            />
          </div>
        </div>
        <div className="hero-stat">
          <h3>{firstPlaceLabel(country)}</h3>
          <div className="hero-mid gold-text">{fmtNum(eff.country)}</div>
          {data.globalTops.checked > 0 && (
            <>
            <h3 className="hero-sub">Global tops</h3>
            <div className={`global-tops${past ? " tm-dim" : ""}`}>
              {(
                [
                  ["Top 1", data.globalTops.top1],
                  ["Top 8", data.globalTops.top8],
                  ["Top 15", data.globalTops.top15],
                  ["Top 25", data.globalTops.top25],
                  ["Top 50", data.globalTops.top50],
                  ["Top 100", data.globalTops.top100],
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
            {fmtNum(eff.rankedClassic)} <span className="big-unit">Classic Score</span>
          </div>
          {prefs.wither && (
            <div className={`big${past ? " tm-dim" : ""}`}>
              {fmtNum(data.scoreSums.wither)} <span className="big-unit">Wither Score</span>
            </div>
          )}
          <small className={past ? "tm-dim" : undefined}>
            Standardised: {fmtNum(data.scoreSums.lazer)}
          </small>
        </div>
        <div className={`hero-stat${past ? " tm-dim" : ""}`}>
          <h3>Missing score (estimate)</h3>
          <div className="big accent">
            {fmtNum(data.scoreSums.missingClassic)}{" "}
            <span className="big-unit">Classic Score</span>
          </div>
          {prefs.wither && (
            <div className="big accent">
              {fmtNum(data.scoreSums.missingWither)}{" "}
              <span className="big-unit">Wither Score</span>
            </div>
          )}
          <small>Standardised: {fmtNum(data.scoreSums.missing)}</small>
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
          <div className={`grade-dist${past ? " tm-dim" : ""}`}>
            {data.fc.map((f) => (
              <div key={f.fc_state} className="grade-pill">
                <b className={`fc fc-${f.fc_state}`}>{FC_LABELS[f.fc_state]}</b>{" "}
                {fmtNum(f.c)}
              </div>
            ))}
          </div>
        </div>
      </div>

      <HeatmapPanel cutoffDay={past?.day ?? null} />

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
            <DistPanel key={d.title} title={d.title} rows={d.rows} />
          ))}
      </div>

      <SkillCurvePanel />
    </div>
  );
}
