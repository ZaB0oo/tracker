import type { TimelinePoint } from "../api";
import { fmtDate } from "../format";

/**
 * Time machine slider bar. The dashboard owns the timeline data and the
 * selected index: moving the slider rewrites the EXISTING dashboard counters
 * (hero, completion-by-stat panels) and dims the heatmap beyond the chosen
 * date — pure client-side lookups plus one lightweight snapshot request.
 */
export function TimeMachineBar({
  points,
  idx,
  onChange,
}: {
  points: TimelinePoint[];
  idx: number | null;
  onChange: (idx: number | null) => void;
}) {
  if (points.length < 2) return null;
  const i = idx ?? points.length - 1;
  const isPast = i < points.length - 1;

  return (
    <div className="tm-bar">
      <span className="tm-title">Time machine</span>
      <div className={`tm-slider-box${isPast ? " tm-on" : ""}`}>
        <input
          className="tm-slider"
          type="range"
          min={0}
          max={points.length - 1}
          value={i}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(v >= points.length - 1 ? null : v);
          }}
        />
      </div>
      <span className="tm-date">{isPast ? fmtDate(points[i].day) : "today"}</span>
      {/* always rendered so the layout never shifts while sliding */}
      <button
        className="tm-now"
        style={{ visibility: isPast ? "visible" : "hidden" }}
        onClick={() => onChange(null)}
      >
        today
      </button>
    </div>
  );
}
