import { memo, useMemo, useState } from "react";
import type { TimelinePoint } from "../api";
import { fmtCompact, fmtDate, fmtNum } from "../format";

// logical drawing space, scaled by the SVG viewBox
const W = 900;
const H = 210;
const L = 52;
const R = 14;
const T = 12;
const B = 24;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dayMs = 86_400_000;
const doy = (iso: string, year: number) =>
  Math.floor((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(year, 0, 1)) / dayMs) + 1;
const daysInYear = (year: number) =>
  (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / dayMs;

/** step series of one year: gains since Jan 1, one step per activity day */
function yearSeries(
  points: TimelinePoint[],
  year: number,
  value: (p: TimelinePoint) => number
): { t: number; v: number }[] {
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  let base = 0;
  const out: { t: number; v: number }[] = [];
  for (const p of points) {
    if (p.day < start) base = value(p);
    else if (p.day < end) out.push({ t: doy(p.day, year), v: value(p) - base });
  }
  return out;
}

/** step-after path (values only move on activity days) */
function stepPath(
  pts: { t: number; v: number }[],
  x: (t: number) => number,
  y: (v: number) => number,
  endT: number
): string {
  if (pts.length === 0) return "";
  let d = `M ${x(pts[0].t).toFixed(1)} ${y(0).toFixed(1)} V ${y(pts[0].v).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++)
    d += ` H ${x(pts[i].t).toFixed(1)} V ${y(pts[i].v).toFixed(1)}`;
  d += ` H ${x(endT).toFixed(1)}`;
  return d;
}

/**
 * "This year": clears (or ranked score) gained since January 1, with the
 * previous year as a faint reference to race against, day for day. Built
 * from the timeline already in the dashboard's cache: zero extra requests.
 */
export const YearCurvePanel = memo(function YearCurvePanel({
  points,
  dimmed = false,
  year: yearProp,
}: {
  points: TimelinePoint[];
  dimmed?: boolean;
  /** the year to show (follows the heatmap's selector); default: current */
  year?: number;
}) {
  const [metric, setMetric] = useState<"clears" | "ranked">("clears");
  // total = running sum since Jan 1; daily = each day's own gain, as bars
  const [daily, setDaily] = useState(false);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const nowYear = new Date().getUTCFullYear();
  const year = yearProp ?? nowYear;
  const isCurrent = year === nowYear;
  const value = (p: TimelinePoint) => (metric === "clears" ? p.clears : p.ranked);
  const cur = useMemo(() => yearSeries(points, year, value), [points, metric, year]); // eslint-disable-line react-hooks/exhaustive-deps
  const prev = useMemo(() => yearSeries(points, year - 1, value), [points, metric, year]); // eslint-disable-line react-hooks/exhaustive-deps
  const span = daysInYear(year);
  // a past year is complete; the current one stops at today
  const todayT = isCurrent
    ? doy(new Date().toISOString().slice(0, 10), year)
    : span;
  /** per-day gains: the difference between consecutive cumulative steps */
  const deltas = (s: { t: number; v: number }[]) => {
    const out: { t: number; v: number }[] = [];
    let last = 0;
    for (const p of s) {
      if (p.v > last) out.push({ t: p.t, v: p.v - last });
      last = p.v;
    }
    return out;
  };
  // a leap previous year has a day 366 the current 365-day axis lacks: fold
  // it onto Dec 31 so its gains stay drawn, hoverable and counted
  const prevFit = useMemo(
    () => prev.map((p) => (p.t > span ? { ...p, t: span } : p)),
    [prev, span]
  );
  const curD = daily ? deltas(cur) : cur;
  const prevD = daily ? deltas(prevFit) : prevFit;
  const vMax = Math.max(
    1,
    ...curD.map((p) => p.v),
    ...prevD.map((p) => p.v)
  );
  const x = (t: number) => L + ((t - 1) / (span - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / vMax) * (H - T - B);
  const fmt = metric === "clears" ? fmtNum : fmtCompact;
  /** last value at or before day t (0 before the first activity) */
  const at = (s: { t: number; v: number }[], t: number) => {
    let v = 0;
    for (const p of s) {
      if (p.t > t) break;
      v = p.v;
    }
    return v;
  };
  // the whole year is hoverable: beyond today only the previous year has a
  // value, which is exactly what the comparison is for
  const hover = hoverT;
  const hDate = (t: number) =>
    new Date(Date.UTC(year, 0, t)).toISOString().slice(0, 10);
  if (cur.length === 0 && prev.length === 0) return null;
  return (
    <div className={`panel year-curve${dimmed ? " tm-dim" : ""}`}>
      <div className="scatter-head">
        <h3>{isCurrent ? "This year" : year}</h3>
        {/* toggles BEFORE the variable-width texts: clicking one must never
            move the buttons under the cursor */}
        <div className="seg scatter-mode">
          <button
            className={metric === "clears" ? "active" : ""}
            onClick={() => setMetric("clears")}
          >
            Clears
          </button>
          <button
            className={metric === "ranked" ? "active" : ""}
            onClick={() => setMetric("ranked")}
          >
            Ranked score
          </button>
        </div>
        <div className="seg scatter-mode">
          <button className={daily ? "" : "active"} onClick={() => setDaily(false)}>
            Total
          </button>
          <button className={daily ? "active" : ""} onClick={() => setDaily(true)}>
            Daily
          </button>
        </div>
        <span className="scatter-sub">
          {metric === "clears" ? "clears" : "ranked score"}
          {daily ? " per day" : " gained since January 1"}
          {prev.length > 0 ? ` · ${year - 1} in grey` : ""}
        </span>
        <div className="year-curve-now">
          <b>+{fmt(at(cur, todayT))}</b>
          {prev.length > 0 && (
            <i>
              {" "}vs +{fmt(at(prevFit, todayT))} on{" "}
              {/* real date arithmetic: string-replacing the year printed
                  impossible dates (Feb 29 of a non-leap year) and shifted
                  the label off the looked-up day-of-year */}
              {fmtDate(
                new Date(Date.UTC(year - 1, 0, Math.min(todayT, daysInYear(year - 1))))
                  .toISOString()
                  .slice(0, 10)
              )}
            </i>
          )}
        </div>
      </div>
      <svg
        key={`${metric}-${year}-${daily}`}
        viewBox={`0 0 ${W} ${H}`}
        className="year-curve-svg fade-swap"
        width="100%"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const t = 1 + ((e.clientX - rect.left) / rect.width * W - L) / (W - L - R) * (span - 1);
          setHoverT(t >= 1 && t <= span ? Math.round(t) : null);
        }}
        onMouseLeave={() => setHoverT(null)}
      >
        {/* horizontal gridlines on a 1/2/5 step (integer floor: both series
            count whole things, fractional or duplicate labels read wrong) */}
        {(() => {
          const raw = vMax / 4;
          const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
          let step = pow * 10;
          for (const m of [1, 2, 5, 10])
            if (pow * m >= raw) {
              step = pow * m;
              break;
            }
          step = Math.max(1, step);
          const ticks: number[] = [];
          for (let v = step; v <= vMax; v += step) ticks.push(v);
          return ticks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#362d48" strokeWidth={1} />
              <text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="var(--fg-dim)">
                {fmt(v)}
              </text>
            </g>
          ));
        })()}
        {/* month ticks */}
        {MONTHS.map((m, i) => (
          <text
            key={m}
            x={x(doy(`${year}-${String(i + 1).padStart(2, "0")}-01`, year))}
            y={H - 8}
            fontSize={10}
            fill="var(--fg-dim)"
          >
            {m}
          </text>
        ))}
        {daily ? (
          // one bar per active day; the previous year sits dimmed behind
          (() => {
            const bw = Math.max(1.5, ((W - L - R) / span) * 0.7);
            const bar = (p: { t: number; v: number }, fill: string, op: number) => (
              <rect
                key={`${fill}-${p.t}`}
                x={x(p.t) - bw / 2}
                y={y(p.v)}
                width={bw}
                height={Math.max(1, y(0) - y(p.v))}
                fill={fill}
                opacity={op}
              />
            );
            return (
              <>
                {prevD.map((p) => bar(p, "#7d7691", 0.45))}
                {curD.map((p) => bar(p, "var(--accent)", 0.9))}
              </>
            );
          })()
        ) : (
          <>
            {/* previous year: the faint reference over the full 12 months */}
            {prevFit.length > 0 && (
              <path
                d={stepPath(prevFit, x, y, span)}
                fill="none"
                stroke="#7d7691"
                strokeWidth={1.4}
                opacity={0.55}
              />
            )}
            {/* current year, up to today */}
            {cur.length > 0 && (
              <path
                d={stepPath(cur, x, y, todayT)}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
              />
            )}
          </>
        )}
        {hover != null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={T}
            y2={H - B}
            stroke="#9d94b3"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
      </svg>
      {hover != null && (
        <div
          className="curve-tip year-curve-tip"
          style={{ left: `${(x(hover) / W) * 100}%` }}
        >
          <b>{fmtDate(hDate(hover))}</b>
          {hover <= todayT && (
            <div>
              <span className="gauge-dot" style={{ background: "var(--accent)" }} /> {year}{" "}
              <b>
                +{fmt(daily ? curD.find((p) => p.t === hover)?.v ?? 0 : at(cur, hover))}
              </b>
            </div>
          )}
          {prev.length > 0 && (
            <div>
              <span className="gauge-dot" style={{ background: "#7d7691" }} /> {year - 1}{" "}
              <b>
                +{fmt(daily ? prevD.find((p) => p.t === hover)?.v ?? 0 : at(prevFit, hover))}
              </b>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
