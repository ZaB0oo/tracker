import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchVersion, type DashScope } from "./api";
import { DEFAULT_FILTERS, type Filters } from "./types";
import { modeIcon } from "./rulesets";
import { FilterBar } from "./components/FilterBar";
import { PresetBar } from "./components/PresetBar";
import { ScoreTable } from "./components/ScoreTable";
import { HistoryView } from "./components/HistoryView";
import { Dashboard } from "./components/Dashboard";
import { MetricsView } from "./components/MetricsView";
import { SyncBar } from "./components/SyncBar";
import { ActivityWindow } from "./components/ActivityWindow";
import { StreamOverlay } from "./components/StreamOverlay";

export type SortSpec = { id: string; desc: boolean }[];
type View = "table" | "metrics" | "history" | "dashboard";

// Separate windows: ?activity=1 => full-screen feed, ?overlay=1 => OBS overlay
const isActivityWindow = new URLSearchParams(window.location.search).has("activity");
const isOverlayWindow = new URLSearchParams(window.location.search).has("overlay");

const RULESET_TABS: [number, string][] = [
  [0, "osu!"],
  [1, "taiko"],
  [2, "catch"],
  [3, "mania"],
];

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortSpec>([{ id: "missing", desc: true }]);
  const [view, setView] = useState<View>("table");
  const ruleset = filters.ruleset;
  const switchRuleset = (r: number) =>
    // filters are pool-specific: switching mode resets them (like a drill-down).
    // The scoring mode and the converts choice describe WHAT you look at, not a
    // filter on it — they follow you across modes and views.
    setFilters({
      ...DEFAULT_FILTERS,
      mode: filters.mode,
      pool: filters.pool,
      ruleset: r,
    });

  // the dashboard's Ranked/Loved scope, as a Maps status filter
  const scopeStatuses = (scope: DashScope) =>
    scope === "ranked" ? ["1", "2"] : scope === "loved" ? ["4"] : [];

  const drillDown = (f: Filters, s: SortSpec) => {
    setFilters(f);
    setSort(s);
    setView("table");
  };

  // current version + update check (server caches the GitHub lookup daily)
  const { data: ver } = useQuery({
    queryKey: ["version"],
    queryFn: fetchVersion,
    staleTime: 6 * 3600_000,
    refetchInterval: 6 * 3600_000,
  });

  if (isActivityWindow) return <ActivityWindow />;
  if (isOverlayWindow) return <StreamOverlay />;

  return (
    <div className="app">
      {import.meta.env.DEV && ver?.desktop && (
        <div className="dev-wrong-server">
          ⚠ This dev UI is talking to the DESKTOP app's server (port 3727 was
          already taken, your dev server never started). Everything you see —
          and change — is the desktop app's database. Close the tray app, then
          restart <code>npm run dev</code>.
        </div>
      )}
      <header>
        <h1>
          osu!<span className="accent">completionist</span>
          {ver && <span className="app-version">v{ver.current}</span>}
          {ver?.update && (
            <a
              className="app-update"
              href={ver.update.url}
              target="_blank"
              rel="noreferrer"
              title="A new version is available — open the release page"
            >
              v{ver.update.version} available
            </a>
          )}
        </h1>
      </header>

      <nav className="tabs">
        <div className="ruleset-tabs" title="Viewed ruleset">
          {RULESET_TABS.map(([r, label]) => (
            <button
              key={r}
              className={`rs-tab ${ruleset === r ? "active" : ""}`}
              onClick={() => switchRuleset(r)}
              title={label}
            >
              <img className="rs-icon" src={modeIcon(r)} alt="" />
              {label}
            </button>
          ))}
        </div>
        {(
          [
            ["table", "Maps"],
            ["metrics", "Metrics"],
            ["history", "History"],
            ["dashboard", "Dashboard"],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            className={`tab ${view === v ? "active" : ""}`}
            onClick={() => setView(v)}
          >
            {label}
          </button>
        ))}
      </nav>

      <SyncBar ruleset={ruleset} pool={filters.pool} keys={filters.keys} />

      {view === "table" && (
        <>
          <PresetBar filters={filters} sort={sort} onApply={drillDown} />
          <FilterBar filters={filters} onChange={setFilters} />
          <ScoreTable filters={filters} sort={sort} onSortChange={setSort} />
        </>
      )}
      {view === "metrics" && (
        <MetricsView
          ruleset={ruleset}
          onMissingMaps={(ids, name, matching, mRuleset, mPool) =>
            drillDown(
              {
                ...DEFAULT_FILTERS,
                mode: filters.mode,
                ruleset: mRuleset ?? 0,
                // each metric already applies its own pool inside its term;
                // this one only matters when they all agree on it
                pool: mPool ?? "all",
                metricMissing: { ids, name, matching },
              },
              [{ id: "star_rating", desc: false }]
            )
          }
        />
      )}
      {view === "history" && <HistoryView ruleset={ruleset} />}
      {view === "dashboard" && (
        <Dashboard
          ruleset={ruleset}
          pool={filters.pool}
          onPoolChange={(pool) => setFilters({ ...filters, pool })}
          keys={filters.keys}
          onKeysChange={(keys) => setFilters({ ...filters, keys })}
          onViewPack={(tag, scope) => {
            // Maps tab filtered on the pack via the search token (editable)
            setFilters({
              ...DEFAULT_FILTERS,
              mode: filters.mode,
              pool: filters.pool,
              keys: filters.keys,
              ruleset,
              statuses: scopeStatuses(scope),
              q: `pack=${tag}`,
            });
            setView("table");
          }}
          onViewSr={(min, max, scope) => {
            // Maps tab on that star-rating slice (the curve's own bucket),
            // with the dashboard's Ranked/Loved scope carried over so the
            // list contains exactly the maps the curve counted
            setFilters({
              ...DEFAULT_FILTERS,
              mode: filters.mode,
              pool: filters.pool,
              keys: filters.keys,
              ruleset,
              srMin: String(min),
              srMax: max == null ? "" : String(max),
              statuses: scopeStatuses(scope),
            });
            setView("table");
          }}
          onViewRate={(min, max, scope) => {
            // Maps tab on that playback-rate bucket
            setFilters({
              ...DEFAULT_FILTERS,
              mode: filters.mode,
              pool: filters.pool,
              keys: filters.keys,
              ruleset,
              statuses: scopeStatuses(scope),
              // fixed decimals: String(1) is "1", which read as "Rate 1x"
              // next to a "1.09x" upper bound
              rateMin: min.toFixed(1),
              rateMax: Number.isInteger(max) ? max.toFixed(1) : max.toFixed(2),
            });
            setView("table");
          }}
          onViewBucket={(f, scope) => {
            // any completion bar: its bucket as Maps filters. The hero bars
            // carry their own status and win over the dashboard scope.
            setFilters({
              ...DEFAULT_FILTERS,
              mode: filters.mode,
              pool: filters.pool,
              keys: filters.keys,
              ruleset,
              statuses: scopeStatuses(scope),
              ...f,
            });
            setView("table");
          }}
        />
      )}
    </div>
  );
}
