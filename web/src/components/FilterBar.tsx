import { useEffect, useState } from "react";
import { firstPlaceLabel, useCountryCode } from "../country";
import { collectionExportUrl, fetchLazerImportStatus, lazerImport } from "../api";
import { displayGrade } from "../format";
import { useDisplayPrefs } from "../prefs";
import { DEFAULT_FILTERS, type Filters } from "../types";

const GRADES = ["XH", "X", "SH", "S", "A", "B", "C", "D"];
const FC_OPTS = [
  { v: "0", label: "PFC" },
  { v: "1", label: "FC" },
  { v: "2", label: "non-FC" },
];
const STATUS_OPTS = [
  { v: "1", label: "Ranked" },
  { v: "2", label: "Approved" },
  { v: "4", label: "Loved" },
];

/** all map stats are non-negative: strip any minus sign typed or pasted */
const noNeg = (v: string) => v.replace(/-/g, "");

function Range({
  label, min, max, onMin, onMax, step = "any", lo = 0, hi,
}: {
  label: string; min: string; max: string;
  onMin: (v: string) => void; onMax: (v: string) => void;
  step?: string; lo?: number; hi?: number;
}) {
  return (
    <label className="range">
      <span>{label}</span>
      <input type="number" step={step} min={lo} max={hi} placeholder={lo > 0 ? String(lo) : "min"} value={min} onChange={(e) => onMin(noNeg(e.target.value))} />
      <input type="number" step={step} min={lo} max={hi} placeholder={hi != null ? String(hi) : "max"} value={max} onChange={(e) => onMax(noNeg(e.target.value))} />
    </label>
  );
}

export function FilterBar({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
}) {
  const [local, setLocal] = useState(filters);
  const country = useCountryCode();
  const prefs = useDisplayPrefs();
  useEffect(() => setLocal(filters), [filters]);

  // Direct lazer import: button shown only if the server has the importer.
  const [lazerAvailable, setLazerAvailable] = useState(false);
  const [lazerBusy, setLazerBusy] = useState(false);
  useEffect(() => {
    void fetchLazerImportStatus().then((s) => setLazerAvailable(s.available));
  }, []);

  // 300ms debounce for text / numbers
  useEffect(() => {
    const t = setTimeout(() => {
      if (JSON.stringify(local) !== JSON.stringify(filters)) onChange(local);
    }, 300);
    return () => clearTimeout(t);
  }, [local]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    setLocal((f) => ({ ...f, [k]: v }));
  const toggle = (k: "grades" | "fcState" | "statuses", v: string) =>
    setLocal((f) => ({
      ...f,
      [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v],
    }));

  // Active filter badges (excluding mode/search): visible and removable with a
  // click, even when the advanced panel is collapsed.
  const badges: { key: string; label: string; clear: () => void }[] = [];
  if (local.played)
    badges.push({
      key: "played",
      label: local.played === "played" ? "Played" : "Unplayed",
      clear: () => set("played", ""),
    });
  if (local.grades.length)
    badges.push({
      key: "grades",
      label: `Grade: ${local.grades.map((g) => displayGrade(g)).join("/")}`,
      clear: () => set("grades", []),
    });
  if (local.fcState.length)
    badges.push({
      key: "fc",
      label: `FC: ${local.fcState
        .map((v) => FC_OPTS.find((o) => o.v === v)?.label ?? v)
        .join("/")}`,
      clear: () => set("fcState", []),
    });
  if (local.statuses.length)
    badges.push({
      key: "status",
      label: `Status: ${local.statuses
        .map((v) => STATUS_OPTS.find((o) => o.v === v)?.label ?? v)
        .join("/")}`,
      clear: () => set("statuses", []),
    });
  if (local.mods)
    badges.push({ key: "mods", label: `Mods: ${local.mods}`, clear: () => set("mods", "") });
  if (local.countryFirst)
    badges.push({ key: "fr", label: firstPlaceLabel(country), clear: () => set("countryFirst", false) });
  if (local.metricMissing)
    badges.push({
      key: "metric",
      label: `Missing: ${local.metricMissing.name}`,
      clear: () => set("metricMissing", null),
    });
  if (local.platform)
    badges.push({
      key: "platform",
      label: local.platform === "lazer" ? "Best lazer" : "Best stable",
      clear: () => set("platform", ""),
    });
  const rangeBadge = (
    key: string,
    label: string,
    minK: keyof Filters,
    maxK: keyof Filters
  ) => {
    const min = local[minK] as string;
    const max = local[maxK] as string;
    if (min === "" && max === "") return;
    badges.push({
      key,
      label: `${label} ${min || "…"}–${max || "…"}`,
      clear: () => setLocal((f) => ({ ...f, [minK]: "", [maxK]: "" })),
    });
  };
  rangeBadge("sr", "★", "srMin", "srMax");
  rangeBadge("ar", "AR", "arMin", "arMax");
  rangeBadge("od", "OD", "odMin", "odMax");
  rangeBadge("cs", "CS", "csMin", "csMax");
  rangeBadge("len", "Length", "lenMin", "lenMax");
  rangeBadge("year", "Year", "yearMin", "yearMax");

  return (
    <div className="filterbar">
      <div className="filter-row">
        <div className="seg">
          <button className={local.mode === "classic" ? "active" : ""} onClick={() => set("mode", "classic")}>
            Classic
          </button>
          <button className={local.mode === "lazer" ? "active" : ""} onClick={() => set("mode", "lazer")}>
            Standardised
          </button>
        </div>
        <input
          className="search"
          placeholder="Search artist / title / mapper / diff..."
          value={local.q}
          onChange={(e) => set("q", e.target.value)}
        />
        <div className="fbadges">
          {badges.map((b) => (
            <button key={b.key} className="fbadge" onClick={b.clear} title="Click to remove this filter">
              {b.label} ✕
            </button>
          ))}
        </div>
        {(badges.length > 0 || local.q) && (
          <button className="reset" onClick={() => onChange({ ...DEFAULT_FILTERS, mode: local.mode })}>
            Reset all
          </button>
        )}
        <button
          className="export-coll"
          title="Download these maps as a collection.db file"
          onClick={() => {
            const name = window.prompt(
              "Collection name:",
              local.metricMissing ? `Missing - ${local.metricMissing.name}` : "osu!completionist"
            );
            if (name?.trim())
              window.location.href = collectionExportUrl(local, name.trim());
          }}
        >
          ⤓ Collection
        </button>
        {lazerAvailable && (
          <button
            className="export-coll"
            disabled={lazerBusy}
            title="Import these maps as a collection directly into osu!lazer (osu! must be closed; a backup of the database is made first)"
            onClick={() => {
              const name = window.prompt(
                "Collection name (merged into lazer):",
                local.metricMissing ? `Missing - ${local.metricMissing.name}` : "osu!completionist"
              );
              if (!name?.trim()) return;
              setLazerBusy(true);
              lazerImport(local, name.trim())
                .then((r) =>
                  window.alert(
                    `Imported into osu!lazer:\n` +
                      `  ${r.created} collection(s) created, ${r.updated} updated\n` +
                      `  ${r.hashes} map(s) added (of ${r.mapCount} matching)` +
                      (r.invalid ? `\n  ${r.invalid} invalid hash(es) skipped` : "")
                  )
                )
                .catch((e: Error) => window.alert(`lazer import failed:\n${e.message}`))
                .finally(() => setLazerBusy(false));
            }}
          >
            {lazerBusy ? "…" : "⇥ lazer"}
          </button>
        )}
      </div>

      <div className="filter-groups">
        <div className="filter-group">
          <span className="filter-group-label">Play state</span>
          <div className="seg">
            <button className={local.played === "" ? "active" : ""} onClick={() => set("played", "")}>
              All
            </button>
            <button className={local.played === "played" ? "active" : ""} onClick={() => set("played", "played")}>
              Played
            </button>
            <button className={local.played === "unplayed" ? "active" : ""} onClick={() => set("played", "unplayed")}>
              Unplayed
            </button>
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group-label">Grade</span>
          <div className="chips">
            {GRADES.map((g) => (
              <button
                key={g}
                className={`chip ${local.grades.includes(g) ? "on" : ""}`}
                onClick={() => toggle("grades", g)}
              >
                {displayGrade(g)}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group-label">FC</span>
          <div className="chips">
            {FC_OPTS.map((o) => (
              <button
                key={o.v}
                className={`chip ${local.fcState.includes(o.v) ? "on" : ""}`}
                onClick={() => toggle("fcState", o.v)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group-label">Status</span>
          <div className="chips">
            {STATUS_OPTS.map((o) => (
              <button
                key={o.v}
                className={`chip ${local.statuses.includes(o.v) ? "on" : ""}`}
                onClick={() => toggle("statuses", o.v)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group-label">Best</span>
          <div className="chips">
            <button
              className={`chip ${local.platform === "lazer" ? "on" : ""}`}
              title="Best set on lazer (native score)"
              onClick={() => set("platform", local.platform === "lazer" ? "" : "lazer")}
            >
              Lazer
            </button>
            <button
              className={`chip ${local.platform === "stable" ? "on" : ""}`}
              title="Best set on stable (converted score)"
              onClick={() => set("platform", local.platform === "stable" ? "" : "stable")}
            >
              Stable
            </button>
          </div>
        </div>

        <div className="filter-group">
          <span className="filter-group-label">Other</span>
          <div className="chips">
            <button
              className={`chip ${local.countryFirst ? "on" : ""}`}
              title="Only maps where I hold the country #1"
              onClick={() => set("countryFirst", !local.countryFirst)}
            >
              {firstPlaceLabel(country)}
            </button>
          </div>
          <input
            className="mods-input"
            placeholder="Mods (HD,DT)"
            value={local.mods}
            onChange={(e) => set("mods", e.target.value.toUpperCase())}
          />
        </div>

        <div className="filter-group filter-group-ranges">
          <span className="filter-group-label">Ranges</span>
          <div className="ranges">
            <Range label="★" min={local.srMin} max={local.srMax} onMin={(v) => set("srMin", v)} onMax={(v) => set("srMax", v)} />
            <Range label="AR" min={local.arMin} max={local.arMax} onMin={(v) => set("arMin", v)} onMax={(v) => set("arMax", v)} />
            <Range label="OD" min={local.odMin} max={local.odMax} onMin={(v) => set("odMin", v)} onMax={(v) => set("odMax", v)} />
            <Range label="CS" min={local.csMin} max={local.csMax} onMin={(v) => set("csMin", v)} onMax={(v) => set("csMax", v)} />
            <Range label="Length (s)" min={local.lenMin} max={local.lenMax} onMin={(v) => set("lenMin", v)} onMax={(v) => set("lenMax", v)} step="1" />
            <Range label="Rank year" min={local.yearMin} max={local.yearMax} onMin={(v) => set("yearMin", v)} onMax={(v) => set("yearMax", v)} step="1" lo={2007} hi={new Date().getFullYear()} />
          </div>
        </div>
      </div>
    </div>
  );
}
