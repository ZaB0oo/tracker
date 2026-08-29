import { useEffect, useState } from "react";
import { firstPlaceLabel, useCountryCode } from "../country";
import {
  collectionExportUrl,
  fetchLazerCollections,
  fetchLazerImportStatus,
  lazerImport,
  type LazerCollection,
} from "../api";
import { RULESET_HIT_FIELDS, rulesetStatFields } from "../rulesets";
import { displayGrade } from "../format";
import { DEFAULT_FILTERS, GRADE_ORDER, type Filters, type PoolMode } from "../types";
import { NamePrompt } from "./NamePrompt";
import { KeysChips } from "./KeysChips";
import { PoolSeg } from "./PoolSeg";
import { appAlert } from "../dialogs";
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
  label, min, max, onMin, onMax, step = "any", lo = 0, hi, wide = false,
}: {
  label: string; min: string; max: string;
  onMin: (v: string) => void; onMax: (v: string) => void;
  /** wider boxes for the 7-to-9-digit fields (scores): 66px clips them */
  step?: string; lo?: number; hi?: number; wide?: boolean;
}) {
  return (
    <label className={wide ? "range range-wide" : "range"}>
      <span>{label}</span>
      {/* always "min"/"max": showing the bound instead (Global top, Rate) made
          those two fields look like a different control entirely */}
      <input type="number" step={step} min={lo} max={hi} placeholder="min" value={min} onChange={(e) => onMin(noNeg(e.target.value))} />
      <input type="number" step={step} min={lo} max={hi} placeholder="max" value={max} onChange={(e) => onMax(noNeg(e.target.value))} />
    </label>
  );
}

/** Year-month-day range in two native date inputs (empty = unbounded). */
function DateRange({
  label, from, to, onFrom, onTo,
}: {
  label: string; from: string; to: string;
  onFrom: (v: string) => void; onTo: (v: string) => void;
}) {
  return (
    <label className="range range-date">
      <span>{label}</span>
      <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
      <input type="date" value={to} onChange={(e) => onTo(e.target.value)} />
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
  // Collapsed panel: the top row (mode, search, badges, Reset all) never
  // collapses, so a filter can never act while being invisible.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("filtersCollapsed") === "1"
  );
  const country = useCountryCode();
  useEffect(() => setLocal(filters), [filters]);

  // Direct lazer import: button shown only if the server has the importer.
  const [lazerAvailable, setLazerAvailable] = useState(false);
  const [lazerBusy, setLazerBusy] = useState(false);
  // which export is asking for a collection name (window.prompt does not
  // exist in Electron — this drives the in-app NamePrompt modal instead)
  const [naming, setNaming] = useState<"collection" | "lazer" | null>(null);
  // Collections already in lazer, fetched when the prompt opens (the importer
  // reads the realm, which takes a moment and can fail — never block on it).
  const [lazerCollections, setLazerCollections] = useState<LazerCollection[]>([]);
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
  if (local.oneMillion)
    badges.push({ key: "oneM", label: "1M", clear: () => set("oneMillion", false) });
  if (local.keys.length)
    badges.push({
      key: "keys",
      label: `Keys: ${local.keys.map((k) => (k === "other" ? "other" : `${k}K`)).join("/")}`,
      clear: () => set("keys", []),
    });
  if (local.mods)
    badges.push({ key: "mods", label: `Mods: ${local.mods}`, clear: () => set("mods", "") });
  if (local.countryFirst)
    badges.push({ key: "fr", label: firstPlaceLabel(country), clear: () => set("countryFirst", false) });
  if (local.metricMissing)
    badges.push({
      key: "metric",
      // several metrics: neither "missing" nor "to fix" fits them all
      label:
        local.metricMissing.ids.length > 1
          ? `Left to do: ${local.metricMissing.name}`
          : `${local.metricMissing.matching ? "To fix" : "Missing"}: ${local.metricMissing.name}`,
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
    maxK: keyof Filters,
    /** unit printed after each bound ("x" for the playback rate) */
    unit = ""
  ) => {
    const min = local[minK] as string;
    const max = local[maxK] as string;
    if (min === "" && max === "") return;
    const fmt = (v: string) => (v === "" ? "…" : `${v}${unit}`);
    badges.push({
      key,
      label: `${label} ${fmt(min)}–${fmt(max)}`,
      clear: () => setLocal((f) => ({ ...f, [minK]: "", [maxK]: "" })),
    });
  };
  rangeBadge("sr", "★", "srMin", "srMax");
  rangeBadge("ar", "AR", "arMin", "arMax");
  rangeBadge("od", "OD", "odMin", "odMax");
  rangeBadge("hp", "HP", "hpMin", "hpMax");
  rangeBadge("cs", rulesetStatFields(local.ruleset ?? 0).csLabel, "csMin", "csMax");
  rangeBadge("len", "Length", "lenMin", "lenMax");
  rangeBadge("combo", "Max combo", "comboMin", "comboMax");
  // then the ones describing my best, in the order of the "My best" group
  rangeBadge("score", "Score", "scoreMin", "scoreMax");
  rangeBadge("pp", "pp", "ppMin", "ppMax");
  rangeBadge("missing", "Missing", "missingMin", "missingMax");
  rangeBadge("mult", "Multi", "multMin", "multMax", "x");
  rangeBadge("rate", "Rate", "rateMin", "rateMax", "x");
  rangeBadge("globalTop", "Global top", "globalTopMin", "globalTopMax");
  // one badge per bounded hit count, labelled like the field that set it
  for (const f of RULESET_HIT_FIELDS[local.ruleset ?? 0] ?? []) {
    const r = local.hits?.[f.key];
    if (!r || (r.min === "" && r.max === "")) continue;
    const fmt = (v: string) => (v === "" ? "…" : v);
    badges.push({
      key: `hit-${f.key}`,
      label: `${f.label} ${fmt(r.min)}–${fmt(r.max)}`,
      clear: () =>
        setLocal((fl) => {
          const next = { ...fl.hits };
          delete next[f.key];
          return { ...fl, hits: next };
        }),
    });
  }
  rangeBadge("ranked", "Ranked", "rankedFrom", "rankedTo");
  rangeBadge("playedDate", "Played", "playedFrom", "playedTo");

  return (
    <div className="filterbar">
      <div className="filter-row">
        {local.ruleset !== 3 && (
          /* mania: classic IS the standardised score, the toggle is noise */
          <div className="seg">
            <button className={local.mode === "classic" ? "active" : ""} onClick={() => set("mode", "classic")}>
              Classic
            </button>
            <button className={local.mode === "lazer" ? "active" : ""} onClick={() => set("mode", "lazer")}>
              Standardised
            </button>
          </div>
        )}
        {local.ruleset !== 0 && <PoolSeg value={local.pool} onChange={(p) => set("pool", p)} />}
        {local.ruleset === 3 && (
          <KeysChips value={local.keys} onChange={(k) => set("keys", k)} />
        )}
        <input
          className="search"
          placeholder="Search… (ar>9, stars<6, status=r, keys=7, map id)"
          title={"osu!-style filters in the search box:\nstars<6  ar>9  od>=8  cs=4  hp<5  bpm>200\nlength<90 (seconds; 1:30 works too)  combo>1000  keys=7  status=r/l/a\nyear>=2015  creator=name  artist=name  title=name\nA number alone matches a map / mapset id."}
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
          <button className="reset" onClick={() => onChange({ ...DEFAULT_FILTERS, mode: local.mode, ruleset: local.ruleset })}>
            Reset all
          </button>
        )}
        <button
          className="filters-toggle"
          title={
            collapsed
              ? "Show the filter panel"
              : "Hide the filter panel: active filters stay listed as badges"
          }
          onClick={() =>
            setCollapsed((c) => {
              localStorage.setItem("filtersCollapsed", c ? "0" : "1");
              return !c;
            })
          }
        >
          Filters {collapsed ? "▾" : "▴"}
        </button>
        <button
          className="export-coll"
          title="Download these maps as a collection.db file"
          onClick={() => setNaming("collection")}
        >
          ⤓ Collection
        </button>
        {lazerAvailable && (
          <button
            className="export-coll"
            disabled={lazerBusy}
            title="Send these maps to osu!lazer as a collection. Close osu! first, a backup is made."
            onClick={() => {
              setLazerCollections([]);
              void fetchLazerCollections().then(setLazerCollections);
              setNaming("lazer");
            }}
          >
            {lazerBusy ? "…" : "⇥ lazer"}
          </button>
        )}
        {naming && (
          <NamePrompt
            title={
              naming === "lazer" ? "Collection name (into lazer)" : "Collection name"
            }
            existing={naming === "lazer" ? lazerCollections : undefined}
            initial={
              local.metricMissing
                ? local.metricMissing.ids.length > 1
                  ? `Left to do - ${local.metricMissing.name}`
                  : `${local.metricMissing.matching ? "To fix" : "Missing"} - ${local.metricMissing.name}`
                : "osu!completionist"
            }
            submitLabel={naming === "lazer" ? "Import into lazer" : "Download"}
            onClose={() => setNaming(null)}
            onSubmit={(name, replace) => {
              if (naming === "collection") {
                window.location.href = collectionExportUrl(local, name);
                return;
              }
              setLazerBusy(true);
              lazerImport(local, name, replace)
                .then((r) =>
                  appAlert(
                    `Imported into osu!lazer:\n` +
                      `  ${r.created} collection(s) created, ${r.updated} ${replace ? "replaced" : "updated"}\n` +
                      `  ${r.hashes} map(s) added (of ${r.mapCount} matching)` +
                      (r.remapped
                        ? `\n  ${r.remapped} remapped to your installed (outdated) versions`
                        : "") +
                      (r.notInstalled
                        ? `\n  ${r.notInstalled} map(s) not installed in lazer (will appear once downloaded)`
                        : "") +
                      (r.invalid ? `\n  ${r.invalid} invalid hash(es) skipped` : "")
                  )
                )
                .catch((e: Error) => appAlert(`lazer import failed:\n${e.message}`))
                .finally(() => setLazerBusy(false));
            }}
          />
        )}
      </div>

      {!collapsed && (
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
            {GRADE_ORDER.map((g) => (
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
            {local.ruleset === 3 && (
              <button
                className={`chip ${local.oneMillion ? "on" : ""}`}
                title="Maps with a perfect 1,000,000 play"
                onClick={() => set("oneMillion", !local.oneMillion)}
              >
                1M
              </button>
            )}
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

        {/* Properties of the MAP itself. */}
        <div className="filter-group filter-group-ranges">
          <span className="filter-group-label">Map</span>
          <div className="ranges">
            <Range label="★" min={local.srMin} max={local.srMax} onMin={(v) => set("srMin", v)} onMax={(v) => set("srMax", v)} />
            {rulesetStatFields(local.ruleset ?? 0).ar && (
              <Range label="AR" min={local.arMin} max={local.arMax} onMin={(v) => set("arMin", v)} onMax={(v) => set("arMax", v)} />
            )}
            <Range label="OD" min={local.odMin} max={local.odMax} onMin={(v) => set("odMin", v)} onMax={(v) => set("odMax", v)} />
            <Range label="HP" min={local.hpMin} max={local.hpMax} onMin={(v) => set("hpMin", v)} onMax={(v) => set("hpMax", v)} />
            {rulesetStatFields(local.ruleset ?? 0).cs && (
              <Range label={rulesetStatFields(local.ruleset ?? 0).csLabel} min={local.csMin} max={local.csMax} onMin={(v) => set("csMin", v)} onMax={(v) => set("csMax", v)} />
            )}
            <Range label="Length (s)" min={local.lenMin} max={local.lenMax} onMin={(v) => set("lenMin", v)} onMax={(v) => set("lenMax", v)} step="1" />
            <Range label="Max combo" min={local.comboMin} max={local.comboMax} onMin={(v) => set("comboMin", v)} onMax={(v) => set("comboMax", v)} step="1" lo={0} />
            <DateRange label="Ranked" from={local.rankedFrom} to={local.rankedTo} onFrom={(v) => set("rankedFrom", v)} onTo={(v) => set("rankedTo", v)} />
          </div>
        </div>

        {/* Properties of MY best score on it. */}
        <div className="filter-group filter-group-ranges">
          <span className="filter-group-label">My best</span>
          <div className="ranges">
            {/* What the best is worth, and what is left on the map: both in
                the unit the Classic / Standardised toggle displays, like the
                two columns they bound. */}
            <Range
              label="Score"
              min={local.scoreMin}
              max={local.scoreMax}
              onMin={(v) => set("scoreMin", v)}
              onMax={(v) => set("scoreMax", v)}
              wide
              step="1"
              lo={0}
            />
            <Range
              label="Missing"
              min={local.missingMin}
              max={local.missingMax}
              onMin={(v) => set("missingMin", v)}
              onMax={(v) => set("missingMax", v)}
              wide
              step="1"
              lo={0}
            />
            <Range
              label="pp"
              min={local.ppMin}
              max={local.ppMax}
              onMin={(v) => set("ppMin", v)}
              onMax={(v) => set("ppMax", v)}
              step="0.01"
              lo={0}
            />
            {/* How it was played. The mods are the mods OF that best score,
                not of the map; the multiplier and the rate both derive from
                them, hence the three side by side. */}
            <label className="range mods-field">
              <span>Mods</span>
              <input
                className="mods-input"
                placeholder="HD,DT · NM = nomod"
                value={local.mods}
                onChange={(e) => set("mods", e.target.value.toUpperCase())}
              />
            </label>
            <Range
              label="Multi"
              min={local.multMin}
              max={local.multMax}
              onMin={(v) => set("multMin", v)}
              onMax={(v) => set("multMax", v)}
              step="0.01"
              lo={0}
            />
            <Range
              label="Rate"
              min={local.rateMin}
              max={local.rateMax}
              onMin={(v) => set("rateMin", v)}
              onMax={(v) => set("rateMax", v)}
              step="0.05"
              lo={0.5}
            />
            {/* Where it ranks. */}
            <button
              className={`chip ${local.countryFirst ? "on" : ""}`}
              title="Only maps where I hold the country #1"
              onClick={() => set("countryFirst", !local.countryFirst)}
            >
              {firstPlaceLabel(country)}
            </button>
            <Range
              label="Global top"
              min={local.globalTopMin}
              max={local.globalTopMax}
              onMin={(v) => set("globalTopMin", v)}
              onMax={(v) => set("globalTopMax", v)}
              step="1"
              lo={1}
            />
            <DateRange label="Played" from={local.playedFrom} to={local.playedTo} onFrom={(v) => set("playedFrom", v)} onTo={(v) => set("playedTo", v)} />
          </div>
        </div>

        {/* Hit counts of the best score, per ruleset: 300/100/50/misses in
            std (plus the two computed ones), droplets in catch, 305/300/200…
            in mania. Any bound implies a played map. */}
        <div className="filter-group filter-group-ranges">
          <span className="filter-group-label">Hits</span>
          <div className="ranges">
            {(RULESET_HIT_FIELDS[local.ruleset ?? 0] ?? []).map((f) => {
              const r = local.hits?.[f.key] ?? { min: "", max: "" };
              const setHit = (next: { min: string; max: string }) =>
                setLocal((fl) => ({ ...fl, hits: { ...fl.hits, [f.key]: next } }));
              return (
                <Range
                  key={f.key}
                  label={f.label}
                  min={r.min}
                  max={r.max}
                  onMin={(v) => setHit({ ...r, min: v })}
                  onMax={(v) => setHit({ ...r, max: v })}
                  step="1"
                  lo={0}
                />
              );
            })}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
