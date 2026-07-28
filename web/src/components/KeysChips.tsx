const KEYS = ["4", "7", "other"] as const;

/**
 * Mania key-count filter (4K / 7K / anything else). Same pill as the grade
 * badges; empty selection = every key count. Converts use the key count osu!
 * gives them (lazer's ManiaBeatmapConverter), not their raw circle size.
 */
export function KeysChips({
  value,
  onChange,
}: {
  value: string[];
  onChange: (keys: string[]) => void;
}) {
  return (
    <div
      className="chips"
      title="Key count"
    >
      {KEYS.map((k) => (
        <button
          key={k}
          className={`chip chip-keys ${value.includes(k) ? "on" : ""}`}
          onClick={() =>
            onChange(
              value.includes(k) ? value.filter((x) => x !== k) : [...value, k]
            )
          }
        >
          {k === "other" ? "Other" : `${k}K`}
        </button>
      ))}
    </div>
  );
}
