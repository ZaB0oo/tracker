import { useId, useRef, useState } from "react";
import { fmtNum } from "../format";

/** Tooltip position (0..1 fractions), pulled inward near edges so it never overflows. */
function tipPos(fx: number, fy: number): React.CSSProperties {
  const anchorX = fx < 0.25 ? "0%" : fx > 0.75 ? "-100%" : "-50%";
  const anchorY = fy < 0.55 ? "14px" : "calc(-100% - 14px)";
  return {
    left: `${(Math.min(Math.max(fx, 0.02), 0.98) * 100).toFixed(2)}%`,
    top: `${(fy * 100).toFixed(2)}%`,
    transform: `translate(${anchorX}, ${anchorY})`,
  };
}

/** Rounds up to a "nice" value (1/2/5 × 10^k) for the axes. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

/**
 * Cumulative evolution chart (pink line + fade, no points). Zoom by dragging a
 * horizontal selection; double-click to reset. Shows a title-less compact form
 * when `bare` (used inside a metric card that has its own header).
 */
export function EvoChart({
  title,
  data,
  fmtY = fmtNum,
  bare = false,
}: {
  title?: string;
  data: { period: string; value: number }[];
  fmtY?: (v: number) => string;
  bare?: boolean;
}) {
  const gradId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const view = zoom ? data.slice(zoom[0], zoom[1] + 1) : data;
  const n = view.length;
  const W = 1000, H = 320, ML = 92, MR = 16, MT = 12, MB = 34;
  const FS = 15; // axis label font size (viewBox units)
  const plotBot = H - MB;
  const x = (i: number) => ML + (n > 1 ? i / (n - 1) : 0.5) * (W - ML - MR);
  const yMax = niceCeil(Math.max(...view.map((r) => r.value), 1));
  const y = (v: number) => MT + (1 - v / yMax) * (plotBot - MT);
  const line = view
    .map((r, i) => `${x(i).toFixed(1)},${y(r.value).toFixed(1)}`)
    .join(" ");
  const area = `${x(0).toFixed(1)},${plotBot} ${line} ${x(n - 1).toFixed(1)},${plotBot}`;
  const xLabels = [0, 0.5, 1].map((f) => Math.round((n - 1) * f));

  const idxFromEvent = (e: React.MouseEvent): number => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - ML) / (W - ML - MR)) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };

  const chart = (
    <div className="curve-chart evo-zoomable">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        onMouseLeave={() => {
          setHover(null);
          setDrag(null);
        }}
        onMouseDown={(e) => setDrag([idxFromEvent(e), idxFromEvent(e)])}
        onMouseMove={(e) => {
          const i = idxFromEvent(e);
          setHover(i);
          setDrag((d) => (d ? [d[0], i] : null));
        }}
        onMouseUp={() => {
          if (drag) {
            const a = Math.min(drag[0], drag[1]);
            const b = Math.max(drag[0], drag[1]);
            if (b - a >= 2) {
              const base = zoom ? zoom[0] : 0;
              setZoom([base + a, base + b]);
              setHover(null);
            }
          }
          setDrag(null);
        }}
        onDoubleClick={() => setZoom(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line
              x1={ML} x2={W - MR} y1={y(yMax * f)} y2={y(yMax * f)}
              stroke="var(--border)" strokeDasharray="3 4"
            />
            <text
              x={ML - 10} y={y(yMax * f) + FS / 3} textAnchor="end"
              fill="var(--fg-dim)" fontSize={FS}
            >
              {fmtY(yMax * f)}
            </text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text
            key={i} x={x(i)} y={H - 10} textAnchor="middle"
            fill="var(--fg-dim)" fontSize={FS}
          >
            {view[i]?.period}
          </text>
        ))}
        <polygon points={area} fill={`url(#${gradId})`} />
        <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {drag && (
          <rect
            x={Math.min(x(drag[0]), x(drag[1]))} y={MT}
            width={Math.abs(x(drag[1]) - x(drag[0]))} height={plotBot - MT}
            fill="var(--accent2)" fillOpacity="0.15"
          />
        )}
        {hover != null && !drag && (
          <line
            x1={x(hover)} x2={x(hover)} y1={MT} y2={plotBot}
            stroke="var(--fg-dim)" strokeOpacity="0.5"
          />
        )}
      </svg>
      {hover != null && !drag && view[hover] && (
        <div className="curve-tip" style={tipPos(x(hover) / W, y(view[hover].value) / H)}>
          <b>{view[hover].period}</b>
          <br />
          {fmtNum(view[hover].value)}
        </div>
      )}
    </div>
  );

  if (bare) return chart;
  return (
    <div className="panel">
      <div className="evo-head">
        <h3>{title}</h3>
        {zoom && <button onClick={() => setZoom(null)}>Reset zoom</button>}
      </div>
      {chart}
    </div>
  );
}
