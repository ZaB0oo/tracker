import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchVersion } from "./api";
import { DEFAULT_FILTERS, type Filters } from "./types";
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
    // filters are pool-specific: switching mode resets them (like a drill-down)
    setFilters({ ...DEFAULT_FILTERS, mode: filters.mode, ruleset: r });

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
            >
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

      <SyncBar />

      {view === "table" && (
        <>
          <PresetBar filters={filters} sort={sort} onApply={drillDown} />
          <FilterBar filters={filters} onChange={setFilters} />
          <ScoreTable filters={filters} sort={sort} onSortChange={setSort} />
        </>
      )}
      {view === "metrics" && (
        <MetricsView
          onMissingMaps={(id, name, matching) =>
            drillDown(
              { ...DEFAULT_FILTERS, mode: filters.mode, metricMissing: { id, name, matching } },
              [{ id: "star_rating", desc: false }]
            )
          }
        />
      )}
      {view === "history" && <HistoryView />}
      {view === "dashboard" && <Dashboard ruleset={ruleset} />}
    </div>
  );
}
