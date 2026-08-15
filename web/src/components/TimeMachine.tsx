import { useEffect, useState } from "react";
import type { TimelinePoint } from "../api";

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
  const last = Math.max(points.length - 1, 0);
  // CLAMPED: the selected index survives a scope/pool/ruleset switch, and the
  // new timeline can be much shorter — an out-of-range index used to blow up
  // the whole dashboard (points[i].day on undefined)
  const i = Math.min(Math.max(idx ?? last, 0), last);
  // What is being TYPED in the date field. A controlled input rejected every
  // intermediate value (typing 2026 goes through years 0002, 0020, 0202) and
  // reset itself on each keystroke, so only the picker was usable. The draft
  // is kept until the date is both complete and inside the timeline.
  const [draft, setDraft] = useState<string | null>(null);

  // ←/→ move the selected day by one point (Shift = 10). Ignored while typing
  // in an input, so the date field and the search boxes keep their arrows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // Alt+←/Cmd+← are browser Back, Ctrl+← is word-wise navigation
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable)
        return;
      // a modal is on top: it owns the keyboard (rewinding the dashboard
      // behind it would fire snapshot requests the user cannot even see)
      if (document.querySelector(".modal-overlay")) return;
      const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
      const next = Math.min(Math.max(i + step, 0), last);
      onChange(next >= last ? null : next);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, last, onChange]);

  if (points.length < 2) return null;
  const isPast = i < last;
  const day = points[i].day;
  const first = points[0].day;
  const lastDay = points[last].day;

  return (
    <div className="tm-bar">
      <span className="tm-title">Time machine</span>
      <div className={`tm-slider-box${isPast ? " tm-on" : ""}`}>
        <input
          className="tm-slider"
          type="range"
          min={0}
          max={last}
          value={i}
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(v >= last ? null : v);
          }}
        />
      </div>
      {/* The date field IS the readout (it used to be duplicated by a text
          label next to it). Typing a date jumps there: the slider alone made
          a precise day a pixel-hunt over 10+ years of history. */}
      <input
        className={`tm-date-input${isPast ? " tm-on-date" : ""}`}
        type="date"
        value={draft ?? day}
        min={first}
        max={lastDay}
        title="Jump to a date (← → to step day by day, Shift for 10)"
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          // only jump on a COMPLETE date inside the timeline: half-typed
          // years would otherwise send the dashboard back to day one
          if (!v || v < first || v > lastDay) return;
          // no point on that exact day: take the first one at or after it,
          // so any date lands on the state as it was that day
          const at = points.findIndex((p) => p.day >= v);
          onChange(at < 0 || at >= last ? null : at);
          setDraft(null); // the slider is now the source of truth again
        }}
        // an abandoned half-typed date must not stay on screen
        onBlur={() => setDraft(null)}
      />
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
