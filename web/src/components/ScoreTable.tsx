import { useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { fetchTable } from "../api";
import { GradeBadge } from "./GradeBadge";
import { MedalIcon } from "./Icons";
import { FC_LABELS, STATUS_LABELS, type Filters, type TableRow } from "../types";
import { MapModal } from "./MapModal";
import type { SortSpec } from "../App";

const PAGE = 200;

interface Col {
  id: string;
  label: string;
  width: number;
  sortable?: boolean;
  render: (r: TableRow) => React.ReactNode;
  className?: (r: TableRow) => string;
}

const fmtInt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US");
const fmtLen = (s: number | null) =>
  s == null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const fmtDate = (d: string | null) => (d ? d.slice(0, 10) : "—");
const grade = (g: string | null) =>
  g === "X" ? "SS" : g === "XH" ? "SSH" : g ?? "—";

/** Visible detail of the custom rate (DT/NC/HT/DC: speed_change, WU/WD: final_rate). */
function modLabel(m: { acronym: string; settings?: Record<string, unknown> }): string {
  const s = m.settings ?? {};
  const speed = s.speed_change as number | undefined;
  const finalRate = s.final_rate as number | undefined;
  if (speed != null) return `${m.acronym} ${speed}x`;
  if (finalRate != null) return `${m.acronym} →${finalRate}x`;
  return m.acronym;
}

function Mods({ raw }: { raw: string | null }) {
  const mods = useMemo(() => {
    try {
      return raw ? (JSON.parse(raw) as { acronym: string; settings?: Record<string, unknown> }[]) : [];
    } catch {
      return [];
    }
  }, [raw]);
  if (mods.length === 0) return <span className="mods-none">NM</span>;
  return (
    <span className="mods">
      {mods.map((m, i) => (
        <span
          key={i}
          className={`mod mod-${m.acronym}`}
          title={m.settings ? JSON.stringify(m.settings) : undefined}
        >
          {modLabel(m)}
        </span>
      ))}
    </span>
  );
}

const COLUMNS: Col[] = [
  { id: "artist", label: "Artist", width: 150, sortable: true, render: (r) => r.artist },
  {
    id: "title", label: "Title", width: 200, sortable: true,
    render: (r) => (
      <>
        {r.title}
        {r.dmca ? (
          <span className="dmca-flag" title="Download removed (DMCA)">
            {" "}⛔
          </span>
        ) : null}
      </>
    ),
  },
  { id: "version", label: "Diff", width: 140, sortable: true, render: (r) => r.version },
  { id: "creator", label: "Mapper", width: 110, sortable: true, render: (r) => r.creator },
  {
    id: "grade", label: "Grade", width: 55, sortable: true,
    render: (r) => <GradeBadge grade={r.grade} width={36} title={grade(r.grade)} />,
    className: () => "grade-cell",
  },
  {
    id: "fc_state", label: "FC", width: 65, sortable: true,
    render: (r) => (r.fc_state == null ? "—" : FC_LABELS[r.fc_state]),
    className: (r) => `fc fc-${r.fc_state ?? "none"}`,
  },
  { id: "score", label: "Score", width: 101, sortable: true, render: (r) => fmtInt(r.score_value) },
  {
    id: "missing", label: "Missing", width: 101, sortable: true,
    render: (r) => fmtInt(r.missing_value),
    className: (r) => (r.missing_value === 0 ? "missing-zero" : "missing"),
  },
  {
    id: "missing_pct", label: "Missing %", width: 75, sortable: true,
    render: (r) => (r.missing_pct != null ? `${r.missing_pct.toFixed(1)}%` : "—"),
    className: (r) => (r.missing_value === 0 ? "missing-zero" : "missing"),
  },
  {
    id: "accuracy", label: "Acc", width: 65, sortable: true,
    render: (r) => (r.accuracy == null ? "—" : `${(r.accuracy * 100).toFixed(2)}%`),
  },
  { id: "mods_col", label: "Mods", width: 140, render: (r) => <Mods raw={r.mods} /> },
  {
    id: "mod_multiplier", label: "Multi", width: 60, sortable: true,
    render: (r) => (r.mod_multiplier == null ? "—" : `×${r.mod_multiplier.toFixed(2)}`),
  },
  {
    id: "country_first", label: "#1", width: 40,
    render: (r) => (r.country_first ? <MedalIcon width={15} /> : ""),
  },
  { id: "pp", label: "pp", width: 45, sortable: true, render: (r) => (r.pp == null ? "—" : Math.round(r.pp)) },
  { id: "ended_at", label: "Played on", width: 90, sortable: true, render: (r) => fmtDate(r.ended_at) },
  {
    id: "score_combo", label: "Combo", width: 90, sortable: true,
    render: (r) =>
      r.score_max_combo == null
        ? "—"
        : `${r.score_max_combo}${r.map_max_combo ? `/${r.map_max_combo}` : ""}`,
  },
  { id: "star_rating", label: "★", width: 55, sortable: true, render: (r) => r.star_rating?.toFixed(2) ?? "—" },
  {
    id: "status", label: "Status", width: 70, sortable: true,
    render: (r) => STATUS_LABELS[r.status] ?? r.status,
    className: (r) => `status status-${r.status}`,
  },
  { id: "ranked_date", label: "Ranked", width: 90, sortable: true, render: (r) => fmtDate(r.ranked_date) },
  { id: "total_length", label: "Length", width: 60, sortable: true, render: (r) => fmtLen(r.total_length) },
  { id: "ar", label: "AR", width: 45, sortable: true, render: (r) => r.ar ?? "—" },
  { id: "od", label: "OD", width: 45, sortable: true, render: (r) => r.od ?? "—" },
  { id: "cs", label: "CS", width: 45, sortable: true, render: (r) => r.cs ?? "—" },
  { id: "hp", label: "HP", width: 45, sortable: true, render: (r) => r.hp ?? "—" },
  { id: "bpm", label: "BPM", width: 75, sortable: true, render: (r) => r.bpm ?? "—" },
];

export function ScoreTable({
  filters,
  sort,
  onSortChange,
}: {
  filters: Filters;
  sort: SortSpec;
  onSortChange: (s: SortSpec) => void;
}) {
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("hiddenCols") ?? "[]");
    } catch {
      return [];
    }
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const toggleCol = (id: string) => {
    setHidden((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem("hiddenCols", JSON.stringify(next));
      return next;
    });
  };
  const visibleCols = useMemo(
    () => COLUMNS.filter((c) => !hidden.includes(c.id)),
    [hidden]
  );
  const [ctx, setCtx] = useState<{ x: number; y: number; row: TableRow } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  const query = useInfiniteQuery({
    queryKey: ["table", filters, sort],
    queryFn: ({ pageParam }) => fetchTable(filters, sort, pageParam, PAGE),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.rows) ?? [],
    [query.data]
  );
  const total = query.data?.pages[0]?.total ?? 0;

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 34,
    overscan: 20,
  });

  const items = virtualizer.getVirtualItems();
  const lastItem = items[items.length - 1];
  if (
    lastItem &&
    lastItem.index >= rows.length - 50 &&
    query.hasNextPage &&
    !query.isFetchingNextPage
  ) {
    void query.fetchNextPage();
  }

  const toggleSort = (colId: string, shift: boolean) => {
    const existing = sort.find((s) => s.id === colId);
    let next: SortSpec;
    if (existing) {
      next = sort.map((s) => (s.id === colId ? { ...s, desc: !s.desc } : s));
    } else {
      next = shift ? [...sort, { id: colId, desc: true }] : [{ id: colId, desc: true }];
    }
    onSortChange(next);
  };

  const totalWidth = visibleCols.reduce((n, c) => n + c.width, 0);

  return (
    <div className="table-wrap">
      <div className="table-meta">
        <span>
          {query.isLoading
            ? "Loading..."
            : `${total.toLocaleString("en-US")} maps — multi-column sort: Shift+click`}
        </span>
        <div className="colpicker">
          <button className="colpicker-btn" onClick={() => setPickerOpen((o) => !o)}>
            Columns ▾
          </button>
          {pickerOpen && (
            <>
              <div className="menu-overlay" onClick={() => setPickerOpen(false)} />
              <div className="colpicker-menu">
                {COLUMNS.map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={!hidden.includes(c.id)}
                      onChange={() => toggleCol(c.id)}
                    />
                    {c.label || c.id}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="table-scroll" ref={parentRef}>
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          <div className="thead" style={{ display: "flex" }}>
            {visibleCols.map((c) => {
              const s = sort.find((x) => x.id === c.id);
              const idx = sort.findIndex((x) => x.id === c.id);
              return (
                <div
                  key={c.id}
                  className={`th ${c.sortable ? "sortable" : ""}`}
                  style={{ width: c.width, flexShrink: 0 }}
                  onClick={(e) => c.sortable && toggleSort(c.id, e.shiftKey)}
                >
                  {c.label}
                  {s && (
                    <span className="sort-ind">
                      {s.desc ? "▼" : "▲"}
                      {sort.length > 1 ? idx + 1 : ""}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {query.isLoading && (
            <div>
              {[...Array(15)].map((_, i) => (
                <div key={i} className="skeleton skeleton-row" />
              ))}
            </div>
          )}
          {!query.isLoading && rows.length === 0 && (
            <div className="empty-state">
              <p>No map matches these filters.</p>
              <p className="empty-hint">
                Remove filters via their badges above the table, or « Reset all
                ».
              </p>
            </div>
          )}
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((vi) => {
              const r = rows[vi.index];
              return (
                <div
                  key={r.beatmap_id}
                  className={`tr ${r.played ? "" : "unplayed"} ${vi.index % 2 ? "row-alt" : ""}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    transform: `translateY(${vi.start}px)`,
                    display: "flex",
                    height: vi.size,
                    width: "100%",
                  }}
                  onDoubleClick={() =>
                    window.open(`https://osu.ppy.sh/b/${r.beatmap_id}`, "_blank")
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtx({ x: e.clientX, y: e.clientY, row: r });
                  }}
                >
                  {visibleCols.map((c) => (
                    <div
                      key={c.id}
                      className={`td ${c.className?.(r) ?? ""}`}
                      style={{ width: c.width, flexShrink: 0 }}
                    >
                      {c.render(r)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {ctx && (
        <>
          <div className="ctx-overlay" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />
          <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
            <div className="ctx-title">
              {ctx.row.artist} – {ctx.row.title} [{ctx.row.version}]
            </div>
            <button
              onClick={() => {
                setDetailId(ctx.row.beatmap_id);
                setCtx(null);
              }}
            >
              Map details
            </button>
            <button
              onClick={() => {
                window.open(`https://osu.ppy.sh/b/${ctx.row.beatmap_id}`, "_blank");
                setCtx(null);
              }}
            >
              Open on osu.ppy.sh
            </button>
            <button
              onClick={() => {
                window.location.href = `osu://b/${ctx.row.beatmap_id}`;
                setCtx(null);
              }}
            >
              Open in osu! (osu!direct)
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(String(ctx.row.beatmap_id));
                setCtx(null);
              }}
            >
              Copy beatmap id
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(
                  `${ctx.row.artist} - ${ctx.row.title} [${ctx.row.version}]`
                );
                setCtx(null);
              }}
            >
              Copy « artist - title [diff] »
            </button>
          </div>
        </>
      )}
      {detailId != null && (
        <MapModal beatmapId={detailId} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}
