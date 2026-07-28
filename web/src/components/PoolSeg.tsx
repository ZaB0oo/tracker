import type { PoolMode } from "../types";

const OPTIONS: [PoolMode, string, string][] = [
  ["all", "All", "Its own maps plus the converts, like your osu! profile"],
  ["specific", "Specifics", "Only the maps made for this mode"],
  ["converts", "Converts", "Only the osu! maps playable in this mode"],
];

/**
 * Which maps of the viewed ruleset the views count. Meaningless for osu!std
 * (no converts), so callers only render it for the other modes.
 */
export function PoolSeg({
  value,
  onChange,
}: {
  value: PoolMode;
  onChange: (pool: PoolMode) => void;
}) {
  return (
    <div className="seg" title="Which maps to count">
      {OPTIONS.map(([v, label, hint]) => (
        <button
          key={v}
          className={value === v ? "active" : ""}
          title={hint}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
