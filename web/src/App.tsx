import { useState } from "react";
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

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortSpec>([{ id: "missing", desc: true }]);
  const [view, setView] = useState<View>("table");

  const drillDown = (f: Filters, s: SortSpec) => {
    setFilters(f);
    setSort(s);
    setView("table");
  };

  if (isActivityWindow) return <ActivityWindow />;
  if (isOverlayWindow) return <StreamOverlay />;

  return (
    <div className="app">
      <header>
        <h1>
          osu!<span className="accent">completionist</span>
        </h1>
      </header>

      <nav className="tabs">
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
          onMissingMaps={(id, name) =>
            drillDown(
              { ...DEFAULT_FILTERS, mode: filters.mode, metricMissing: { id, name } },
              [{ id: "star_rating", desc: false }]
            )
          }
        />
      )}
      {view === "history" && <HistoryView />}
      {view === "dashboard" && <Dashboard />}
    </div>
  );
}
