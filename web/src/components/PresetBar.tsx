import { useState } from "react";
import { DEFAULT_FILTERS, type Filters } from "../types";
import type { SortSpec } from "../App";

interface Preset {
  label: string;
  filters: Partial<Filters>;
  sort: SortSpec;
}

/** Built-in presets: ready-made searches, not navigation. */
const BUILTIN: Preset[] = [
  { label: "Unplayed", filters: { played: "unplayed" }, sort: [{ id: "star_rating", desc: false }] },
  { label: "Non-FC", filters: { played: "played", fcState: ["2"] }, sort: [{ id: "missing", desc: true }] },
  { label: "Grades < S", filters: { played: "played", grades: ["A", "B", "C", "D"] }, sort: [{ id: "grade", desc: true }] },
  { label: "My country #1", filters: { frFirst: true }, sort: [{ id: "ended_at", desc: true }] },
  { label: "Missing score", filters: {}, sort: [{ id: "missing", desc: true }] },
  { label: "Best lazer", filters: { platform: "lazer" }, sort: [{ id: "ended_at", desc: true }] },
  { label: "Best stable", filters: { platform: "stable" }, sort: [{ id: "ended_at", desc: true }] },
];

interface SavedPreset {
  label: string;
  filters: Filters;
  sort: SortSpec;
}

function loadCustom(): SavedPreset[] {
  try {
    return JSON.parse(localStorage.getItem("customPresets") ?? "[]");
  } catch {
    return [];
  }
}

export function PresetBar({
  filters,
  sort,
  onApply,
}: {
  filters: Filters;
  sort: SortSpec;
  onApply: (f: Filters, s: SortSpec) => void;
}) {
  const [custom, setCustom] = useState<SavedPreset[]>(loadCustom);

  const saveCurrent = () => {
    const name = window.prompt("Preset name (current filters + sort):");
    if (!name?.trim()) return;
    const next = [
      ...custom.filter((c) => c.label !== name.trim()),
      { label: name.trim(), filters, sort },
    ];
    setCustom(next);
    localStorage.setItem("customPresets", JSON.stringify(next));
  };

  const removeCustom = (label: string) => {
    const next = custom.filter((c) => c.label !== label);
    setCustom(next);
    localStorage.setItem("customPresets", JSON.stringify(next));
  };

  return (
    <div className="presetbar">
      <span className="presetbar-label" title="Predefined searches: filters + sort in one click">
        Presets
      </span>
      {BUILTIN.map((p) => (
        <button
          key={p.label}
          className="chip"
          onClick={() =>
            onApply({ ...DEFAULT_FILTERS, mode: filters.mode, ...p.filters }, p.sort)
          }
        >
          {p.label}
        </button>
      ))}
      {custom.map((p) => (
        <span key={p.label} className="chip chip-custom">
          <button className="chip-apply" onClick={() => onApply({ ...p.filters, mode: filters.mode }, p.sort)}>
            {p.label}
          </button>
          <button
            className="chip-del"
            title="Delete this preset"
            onClick={() => removeCustom(p.label)}
          >
            ✕
          </button>
        </span>
      ))}
      <button className="chip chip-save" title="Save the current filters and sort as a preset" onClick={saveCurrent}>
        💾 Save current filters
      </button>
    </div>
  );
}
