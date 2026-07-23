import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchClears, fetchDaily, fetchTimeline, type TimelinePoint } from "../api";
import { fmtCompact, fmtDate, fmtNum } from "../format";
import { GradeBadge } from "./GradeBadge";
import { MapModal } from "./MapModal";

const CELL = 12;
const GAP = 3;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Color level for a day's clear count (GitHub-style buckets). */
function level(c: number): number {
  if (c === 0) return 0;
  if (c < 5) return 1;
  if (c < 15) return 2;
  if (c < 40) return 3;
  return 4;
}
const COLORS = ["#2a2338", "#5a3752", "#95436f", "#d05189", "#ff66aa"];

interface DayStats {
  clears: number;
  fc: number;
  ranked: number;
  /** per-tier deltas, same order as `tiers` (can be negative: S -> SS upgrade) */
  grades: number[];
}

/**
 * A day's gains = delta between its cumulative timeline point and the
 * previous one (same data the time machine replays — always consistent).
 */
function dayStats(
  points: TimelinePoint[],
  tiers: string[],
  day: string
): DayStats {
  const zero = { clears: 0, fc: 0, ranked: 0, grades: tiers.map(() => 0) };
  const idx = points.findIndex((p) => p.day === day);
  if (idx < 0) return zero; // no activity that day
  const p = points[idx];
  const prev = idx > 0 ? points[idx - 1] : null;
  return {
    clears: p.clears - (prev?.clears ?? 0),
    fc: p.fc - (prev?.fc ?? 0),
    ranked: p.ranked - (prev?.ranked ?? 0),
    grades: tiers.map((_, i) => p.grades[i] - (prev?.grades[i] ?? 0)),
  };
}

/**
 * GitHub-style clears-per-day heatmap + streak stats. When the time machine
 * selects a past day, later days are dimmed.
 */
export function HeatmapPanel({ cutoffDay = null }: { cutoffDay?: string | null }) {
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selDay, setSelDay] = useState(todayIso);
  const { data } = useQuery({
    queryKey: ["daily", year],
    queryFn: () => fetchDaily(year),
    refetchInterval: 5 * 60_000,
  });
  // same key as the dashboard's time machine -> shared cache, no extra request
  const { data: tl } = useQuery({
    queryKey: ["timeline"],
    queryFn: fetchTimeline,
    refetchInterval: 5 * 60_000,
  });
  // maps played on the selected day (one row per map, day's best play)
  const { data: dayClears } = useQuery({
    queryKey: ["day-clears", selDay],
    queryFn: () => fetchClears(0, 500, selDay),
    refetchInterval: 5 * 60_000,
  });
  const [modalId, setModalId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<"time" | "title" | "sr" | "grade">("time");
  const [sortDesc, setSortDesc] = useState(false);
  if (!data) return null;

  const GRADE_ORDER: Record<string, number> = {
    XH: 7, X: 6, SH: 5, S: 4, A: 3, B: 2, C: 1, D: 0,
  };
  const sortedRows = [...(dayClears?.rows ?? [])].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "time": cmp = a.ended_at.localeCompare(b.ended_at); break;
      case "title":
        cmp = `${a.artist} ${a.title} ${a.version}`.localeCompare(
          `${b.artist} ${b.title} ${b.version}`, undefined, { sensitivity: "base" });
        break;
      case "sr": cmp = (a.star_rating ?? -1) - (b.star_rating ?? -1); break;
      case "grade":
        cmp = (GRADE_ORDER[a.rank] ?? -1) - (GRADE_ORDER[b.rank] ?? -1)
          || (a.accuracy - b.accuracy);
        break;
    }
    return sortDesc ? -cmp : cmp;
  });
  const setSort = (key: typeof sortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      // sensible default direction per column
      setSortDesc(key === "sr" || key === "grade");
    }
  };

  const sel = tl ? dayStats(tl.points, tl.tiers, selDay) : null;
  const gradeDeltas = tl
    ? tl.tiers
        .map((t, i) => ({ tier: t, d: sel!.grades[i] }))
        .filter((g) => g.d !== 0)
        .reverse() // XH first
    : [];

  const byDay = new Map(data.days.map((d) => [d.d, d.c]));
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const startDow = jan1.getUTCDay(); // 0 = Sunday
  const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
  const weeks = Math.ceil((startDow + daysInYear) / 7);
  const total = data.days.reduce((n, d) => n + d.c, 0);

  const W = weeks * (CELL + GAP) + 30;
  const H = 7 * (CELL + GAP) + 20;

  return (
    <div className="panel heatmap-panel">
      <div className="heatmap-cols">
      <div className="heatmap-main">
      <div className="heatmap-head">
        <h3>Clears per day</h3>
        <div className="seg">
          <button disabled={year <= data.years.min} onClick={() => setYear((y) => y - 1)}>
            ‹
          </button>
          <button className="active">{year}</button>
          <button disabled={year >= data.years.max} onClick={() => setYear((y) => y + 1)}>
            ›
          </button>
        </div>
        <div className="heatmap-stats">
          <span>
            {year}: <b>{fmtNum(total)}</b> clears
          </span>
          <span>
            streak <b className="accent">{data.streak.current}d</b>
          </span>
          <span>
            record <b>{data.streak.longest}d</b>
          </span>
          {data.streak.best.c > 0 && (
            <span>
              best day <b>{fmtNum(data.streak.best.c)}</b>
              <span className="dim"> ({fmtDate(data.streak.best.d)})</span>
            </span>
          )}
        </div>
      </div>
      <div className="heatmap-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="heatmap-svg" width="100%">
        {MONTHS.map((m, i) => {
          const first = Date.UTC(year, i, 1);
          const week = Math.floor((startDow + (first - +jan1) / 86_400_000) / 7);
          return (
            <text key={m} x={30 + week * (CELL + GAP)} y={10} fontSize="9" fill="var(--fg-dim)">
              {m}
            </text>
          );
        })}
        {["Mon", "Wed", "Fri"].map((d, i) => (
          <text key={d} x={0} y={20 + (1 + i * 2) * (CELL + GAP) + 9} fontSize="8" fill="var(--fg-dim)">
            {d}
          </text>
        ))}
        {Array.from({ length: daysInYear }, (_, i) => {
          const date = new Date(Date.UTC(year, 0, 1 + i));
          const iso = date.toISOString().slice(0, 10);
          const c = byDay.get(iso) ?? 0;
          const idx = startDow + i;
          const wx = Math.floor(idx / 7);
          const dy = idx % 7;
          const dimmed = cutoffDay != null && iso > cutoffDay;
          return (
            <rect
              key={iso}
              x={30 + wx * (CELL + GAP)}
              y={16 + dy * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={2.5}
              fill={COLORS[level(c)]}
              opacity={dimmed ? 0.18 : 1}
              stroke={iso === selDay ? "#ff66aa" : "none"}
              strokeWidth={iso === selDay ? 1.5 : 0}
              style={{ cursor: "pointer" }}
              onClick={() => setSelDay(iso)}
            >
              <title>{`${iso}: ${c} clear(s)`}</title>
            </rect>
          );
        })}
        </svg>
      </div>
      </div>

        {sel && (
          <div className="hm-day">
            <div className="hm-day-head">
              <b>{selDay === todayIso ? "Today" : fmtDate(selDay)}</b>
              {selDay !== todayIso && (
                <button className="hm-day-today" onClick={() => setSelDay(todayIso)}>
                  today
                </button>
              )}
            </div>
            {sel.clears === 0 && sel.fc === 0 && sel.ranked === 0 && gradeDeltas.length === 0 ? (
              <div className="hm-day-empty">No clears</div>
            ) : (
              <>
                <div className="hm-day-summary">
                  <span>
                    <b>+{fmtNum(sel.clears)}</b> clears
                  </span>
                  <span>
                    <b>+{fmtNum(sel.fc)}</b> FC
                  </span>
                  <span>
                    <b>+{fmtCompact(sel.ranked)}</b> ranked
                  </span>
                </div>
                {gradeDeltas.length > 0 && (
                  <div className="hm-day-grades">
                    {gradeDeltas.map((g) => (
                      <span key={g.tier} className="hm-day-grade">
                        <GradeBadge grade={g.tier} width={26} />
                        <b className={g.d < 0 ? "dim" : ""}>
                          {g.d > 0 ? `+${g.d}` : g.d}
                        </b>
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
            {dayClears && dayClears.rows.length > 0 && (
              <div className="hm-day-list">
                <div className="hm-day-list-head">
                  {fmtNum(dayClears.total)} map{dayClears.total > 1 ? "s" : ""} played
                </div>
                <table className="hm-day-table">
                  <thead>
                    <tr>
                      {(
                        [
                          ["grade", "G"],
                          ["title", "map"],
                          ["sr", "★"],
                          ["time", "time"],
                        ] as const
                      ).map(([key, label]) => (
                        <th
                          key={key}
                          className={sortKey === key ? "on" : ""}
                          onClick={() => setSort(key)}
                        >
                          {label}
                          {sortKey === key ? (sortDesc ? " ↓" : " ↑") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r) => (
                      <tr
                        key={r.beatmap_id}
                        title={`${r.artist} - ${r.title} [${r.version}] · ${(r.accuracy * 100).toFixed(2)}%`}
                        onClick={() => setModalId(r.beatmap_id)}
                      >
                        <td>
                          <GradeBadge grade={r.rank} width={24} />
                        </td>
                        <td className="hm-day-map-name">
                          {r.artist} - {r.title} <i>[{r.version}]</i>
                        </td>
                        <td className="hm-day-map-sr">
                          {r.star_rating != null ? r.star_rating.toFixed(1) : "—"}
                        </td>
                        <td className="hm-day-map-time">
                          {new Date(r.ended_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      {modalId != null && (
        <MapModal beatmapId={modalId} onClose={() => setModalId(null)} />
      )}
    </div>
  );
}

