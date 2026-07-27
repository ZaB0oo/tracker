import { useState } from "react";
import type { Filters } from "../types";
import type { SortSpec } from "../App";

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
      {custom.length === 0 && (
        <span className="presetbar-empty">
          none yet — set up filters and save them here
        </span>
      )}
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
