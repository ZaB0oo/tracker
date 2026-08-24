import { useState } from "react";
import type { SessionScore } from "../api";
import { fmtCompact, fmtNum, fmtTime } from "../format";

const hm = (iso: string) => fmtTime(iso).slice(0, 5);

/** metrics of the scatter, one score = one dot. Absolute metrics anchor the
 * axis at zero — a tight auto-fit turned tiny wiggles into cliffs. Accuracy
 * gets a 95% floor instead (extended only if a play sits below it). */
const CHART_METRICS: {
  id: string;
  label: string;
  y: (s: SessionScore) => number | null;
  fmt: (v: number) => string;
  /** axis floor: "zero" anchors at 0, a number is a percentage-like floor */
  floor: number;
}[] = [
  { id: "pp", label: "Performance", y: (s) => s.pp, fmt: (v) => `${Math.round(v)}pp`, floor: 0 },
  { id: "score", label: "Score", y: (s) => s.classic ?? s.std, fmt: (v) => fmtCompact(v), floor: 0 },
  { id: "std", label: "Score (std)", y: (s) => s.std, fmt: (v) => fmtCompact(v), floor: 0 },
  { id: "acc", label: "Accuracy", y: (s) => s.accuracy * 100, fmt: (v) => `${v.toFixed(1)}%`, floor: 95 },
  { id: "combo", label: "Combo", y: (s) => s.combo, fmt: (v) => `${fmtNum(Math.round(v))}x`, floor: 0 },
  { id: "stars", label: "Stars", y: (s) => s.sr, fmt: (v) => `${v.toFixed(2)}★`, floor: 0 },
  {
    id: "len", label: "Length", y: (s) => s.len,
    fmt: (v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}`,
    floor: 0,
  },
];

/**
 * One dot per score over time, on the metric of your choice: the session
 * detail uses it over the sitting (breaks shaded red), the heatmap day view
 * over the whole day (sessions shaded). Hover names the play, clicking a dot
 * opens its map.
 */
export function PlayScatter({
  scores,
  bands = [],
  domain,
  onOpen,
  wide = false,
}: {
  scores: SessionScore[];
  /** shaded time spans behind the dots (ms timestamps) */
  bands?: { from: number; to: number; kind?: "break" | "session" }[];
  /** x-axis bounds (ms); defaults to first..last score */
  domain?: [number, number];
  onOpen: (mapId: number) => void;
  /** full-width host (heatmap day view): flatter aspect, same information */
  wide?: boolean;
}) {
  const [metric, setMetric] = useState("pp");
  const [tip, setTip] = useState<{ fx: number; fy: number; text: string } | null>(null);
  const m = CHART_METRICS.find((x) => x.id === metric) ?? CHART_METRICS[0];
  const W = wide ? 1400 : 800;
  const H = wide ? 260 : 230;
  const L = 54;
  const RGT = 10;
  const T = 10;
  const B = 24;
  const t0 = domain?.[0] ?? Date.parse(scores[0].at);
  const t1 = domain?.[1] ?? Date.parse(scores[scores.length - 1].at);
  const span = Math.max(60_000, t1 - t0);
  const pts = scores
    .map((s) => ({ s, t: Date.parse(s.at), v: m.y(s) }))
    .filter((p): p is { s: SessionScore; t: number; v: number } => p.v != null);
  const dataMin = Math.min(...pts.map((p) => p.v));
  let vMax = Math.max(...pts.map((p) => p.v));
  // anchored floor per metric (see CHART_METRICS)
  let vMin = m.id === "acc" ? Math.min(m.floor, dataMin) : m.floor;
  if (vMin === vMax) {
    vMin -= 1;
    vMax += 1;
  }
  vMax += (vMax - vMin) * 0.06;
  const x = (t: number) => L + ((t - t0) / span) * (W - L - RGT);
  const y = (v: number) => T + (1 - (v - vMin) / (vMax - vMin)) * (H - T - B);
  const yTicks = [0, 1, 2, 3].map((i) => vMin + ((vMax - vMin) * i) / 3);
  const xTicks = [0, 1, 2, 3].map((i) => t0 + (span * i) / 3);
  return (
    <div className="sess-chart">
      <div className="seg sess-chart-seg">
        {CHART_METRICS.map((c) => (
          <button
            key={c.id}
            className={metric === c.id ? "active" : ""}
            onClick={() => setMetric(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {pts.length === 0 ? (
        <div className="sess-detail-empty">No {m.label.toLowerCase()} data on these plays.</div>
      ) : (
        <div className="sess-chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" onMouseLeave={() => setTip(null)}>
          {bands.map((b, i) => {
            const x1 = x(Math.max(b.from, t0));
            const x2 = x(Math.min(b.to, t1));
            return x2 > x1 ? (
              <rect
                key={i}
                x={x1}
                y={T}
                // a one-play session still deserves a visible sliver
                width={Math.max(2, x2 - x1)}
                height={H - T - B}
                className={b.kind === "session" ? "scat-session" : "scat-break"}
              />
            ) : null;
          })}
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={L} x2={W - RGT} y1={y(v)} y2={y(v)} stroke="#362d48" strokeWidth="1" />
              <text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#9d94b3">
                {m.fmt(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={t}
              x={x(t)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              fontSize="10"
              fill="#9d94b3"
            >
              {hm(new Date(t).toISOString())}
            </text>
          ))}
          {pts.map((p) => (
            <circle
              key={p.s.id}
              cx={x(p.t)}
              cy={y(p.v)}
              r="3.5"
              className="sess-dot"
              onClick={() => onOpen(p.s.mapId)}
              onMouseEnter={() =>
                setTip({
                  fx: x(p.t) / W,
                  fy: y(p.v) / H,
                  text: `${hm(p.s.at)} · ${p.s.title} [${p.s.diff}] · ${m.fmt(p.v)}`,
                })
              }
              onMouseLeave={() => setTip(null)}
            />
          ))}
        </svg>
        {tip && (
          <div
            className="curve-tip"
            style={{
              left: `${Math.min(85, Math.max(15, tip.fx * 100))}%`,
              top: `${tip.fy * 100}%`,
              transform: "translate(-50%, -130%)",
            }}
          >
            {tip.text}
          </div>
        )}
        </div>
      )}
    </div>
  );
}
