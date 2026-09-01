import { memo, useMemo, useState } from "react";
import { PanelSkeleton } from "./Skeleton";
import { mapUrl } from "../rulesets";
import { useQuery } from "@tanstack/react-query";
import {
  fetchClears,
  fetchDaily,
  fetchSessionScores,
  fetchTimeline,
  type ClearRow,
  type TimelinePoint,
  type DashScope,
} from "../api";
import { ctxMenuStyle } from "../ctxmenu";
import type { PoolMode } from "../types";
import { fmtCompact, fmtDate, fmtNum } from "../format";
import { GradeBadge } from "./GradeBadge";
import { MapModal } from "./MapModal";
import { PlayScatter } from "./PlayScatter";
import { useTipPlacement } from "../useTipPlacement";

const CELL = 12;
const GAP = 3;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Continuous day color: empty → full pink over 0..100 clears (a 100-clear day
 * and a 300-clear day are both "full", the calendar has no reason to separate
 * them). Buckets used to lump 40+ into one shade, hiding the big sessions.
 */
const CELL_EMPTY: [number, number, number] = [42, 35, 56]; // #2a2338
const CELL_FULL: [number, number, number] = [255, 102, 170]; // #ff66aa
const CELL_MAX = 100;

/** 0 stays the empty color; any activity starts visibly above it. */
function cellColor(c: number): string {
  if (c <= 0) return `rgb(${CELL_EMPTY.join(",")})`;
  const t = 0.14 + 0.86 * Math.min(c / CELL_MAX, 1);
  const mix = CELL_EMPTY.map((from, i) =>
    Math.round(from + (CELL_FULL[i] - from) * t)
  );
  return `rgb(${mix.join(",")})`;
}

/** "HDDTCL" from the score's mods JSON ("" when nomod / unparseable). */
function modsLabel(mods: string): string {
  try {
    return (JSON.parse(mods) as { acronym?: string }[])
      .map((m) => m.acronym ?? "")
      .filter(Boolean)
      .join("");
  } catch {
    return "";
  }
}

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
export const HeatmapPanel = memo(function HeatmapPanel({
  cutoffDay = null,
  ruleset = 0,
  pool = "all",
  keys = [],
  scope = "all",
  year: yearProp,
  onYear,
}: {
  cutoffDay?: string | null;
  ruleset?: number;
  pool?: PoolMode;
  keys?: string[];
  scope?: DashScope;
  /** controlled year (the overview shares it with the year curve) */
  year?: number;
  onYear?: (y: number) => void;
}) {
  const [yearState, setYearState] = useState(new Date().getUTCFullYear());
  const year = yearProp ?? yearState;
  const setYear = (y: number) => {
    setYearState(y);
    onYear?.(y);
  };
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selDay, setSelDay] = useState(todayIso);
  const { data } = useQuery({
    queryKey: ["daily", year, ruleset, pool, keys, scope],
    queryFn: () => fetchDaily(year, ruleset, pool, keys, scope),
    refetchInterval: 5 * 60_000,
  });
  // same key as the dashboard's time machine -> shared cache, no extra request
  const { data: tl } = useQuery({
    queryKey: ["timeline", ruleset, pool, keys, scope],
    queryFn: () => fetchTimeline(ruleset, pool, keys, scope),
    refetchInterval: 5 * 60_000,
  });
  // maps played on the selected day (one row per map, day's best play)
  const { data: dayClears } = useQuery({
    queryKey: ["day-clears", selDay, ruleset, pool, keys, scope],
    queryFn: () => fetchClears(0, 500, selDay, ruleset, pool, keys, scope),
    refetchInterval: 5 * 60_000,
  });
  // every play of that day for the intraday chart (same endpoint as the
  // session detail: the day is just another time span)
  const dayStart = `${selDay}T00:00:00Z`;
  const dayEnd = `${selDay}T23:59:59Z`;
  const { data: dayScores } = useQuery({
    queryKey: ["session-scores", dayStart, dayEnd, ruleset, pool, keys, scope],
    queryFn: () => fetchSessionScores(dayStart, dayEnd, ruleset, pool, keys, scope),
    refetchInterval: 5 * 60_000,
  });
  const [modalId, setModalId] = useState<number | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; row: ClearRow } | null>(null);
  const [sortKey, setSortKey] = useState<"time" | "title" | "sr" | "grade" | "acc">("time");
  const [sortDesc, setSortDesc] = useState(false);
  // Hovered day: the numbers come from the timeline already in cache, so the
  // tooltip costs nothing per cell. The map list stays behind the click — it
  // is a fetch per day, and sweeping the year would fire one per square.
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const { setWrap, tipRef, tipStyle, clearTip } = useTipPlacement(hoverDay);
  // cell geometry computed once per year: 365 Date + toISOString on every
  // render was pure waste on each slider tick
  const cells = useMemo(() => {
    const startDow = new Date(Date.UTC(year, 0, 1)).getUTCDay(); // 0 = Sunday
    const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
    return Array.from({ length: days }, (_, i) => {
      const idx = startDow + i;
      return {
        iso: new Date(Date.UTC(year, 0, 1 + i)).toISOString().slice(0, 10),
        x: 30 + Math.floor(idx / 7) * (CELL + GAP),
        y: 16 + (idx % 7) * (CELL + GAP),
      };
    });
  }, [year]);
  if (!data) return <PanelSkeleton lines={8} />;

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
      case "sr": cmp = ((a.sr_mods ?? a.star_rating) ?? -1) - ((b.sr_mods ?? b.star_rating) ?? -1); break;
      case "grade":
        cmp = (GRADE_ORDER[a.rank] ?? -1) - (GRADE_ORDER[b.rank] ?? -1)
          || (a.accuracy - b.accuracy);
        break;
      case "acc": cmp = a.accuracy - b.accuracy; break;
    }
    return sortDesc ? -cmp : cmp;
  });
  const setSort = (key: typeof sortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      // sensible default direction per column
      setSortDesc(key === "sr" || key === "grade" || key === "acc");
    }
  };

  // active spans of the day (plays under an hour apart, like /sessions),
  // shaded behind the intraday dots
  const daySc = dayScores?.scores ?? [];
  const dayBands: { from: number; to: number; kind: "session" }[] = [];
  {
    let from = 0;
    let prev: number | null = null;
    for (const s of daySc) {
      const t = Date.parse(s.at);
      if (prev == null || t - prev > 3_600_000) {
        if (prev != null) dayBands.push({ from, to: prev, kind: "session" });
        from = t - (s.len ?? 0) * 1000;
      }
      prev = t;
    }
    if (prev != null) dayBands.push({ from, to: prev, kind: "session" });
  }

  const sel = tl ? dayStats(tl.points, tl.tiers, selDay) : null;

  // richer day figures from the day's actual plays (same rows as the chart):
  // net standardised gain, in-map time, best pp, average accuracy
  const dayAgg = (() => {
    let stdGained = 0;
    let inMapSec = 0;
    let bestPp: number | null = null;
    let bestPpEst = false;
    let accSum = 0;
    let accN = 0;
    for (const p of daySc) {
      inMapSec += Math.round(p.len ?? 0);
      if (p.pp != null && (bestPp == null || p.pp > bestPp)) {
        bestPp = p.pp;
        bestPpEst = p.pp_est === 1;
      }
      if (!p.passed) continue;
      accSum += p.accuracy;
      accN++;
      if (p.std > (p.prev_best_std ?? 0))
        stdGained += p.std - (p.prev_best_std ?? 0);
    }
    return { stdGained, inMapSec, bestPp, bestPpEst, avgAcc: accN ? accSum / accN : null };
  })();
  const gradeDeltas = tl
    ? tl.tiers
        .map((t, i) => ({ tier: t, d: sel!.grades[i] }))
        .filter((g) => g.d !== 0)
        .reverse() // XH first
    : [];

  const byDay = new Map(data.days.map((d) => [d.d, d.c]));
  const hoverStats = hoverDay && tl ? dayStats(tl.points, tl.tiers, hoverDay) : null;
  const hoverGrades =
    hoverStats && tl
      ? tl.tiers
          .map((t, i) => ({ tier: t, d: hoverStats.grades[i] }))
          .filter((g) => g.d !== 0)
          .reverse() // XH first, like the day panel
      : [];
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
          <button disabled={year <= data.years.min} onClick={() => setYear(year - 1)}>
            ‹
          </button>
          <button className="active">{year}</button>
          <button disabled={year >= data.years.max} onClick={() => setYear(year + 1)}>
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
      <div className="heatmap-wrap fade-swap" key={year}>
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
        {cells.map(({ iso, x, y }) => {
          const c = byDay.get(iso) ?? 0;
          const dimmed = cutoffDay != null && iso > cutoffDay;
          return (
            <rect
              key={iso}
              x={x}
              y={y}
              width={CELL}
              height={CELL}
              rx={2.5}
              fill={cellColor(c)}
              opacity={dimmed ? 0.18 : 1}
              stroke={iso === selDay ? "#ff66aa" : "none"}
              strokeWidth={iso === selDay ? 1.5 : 0}
              style={{ cursor: "pointer" }}
              onClick={() => setSelDay(iso)}
              onMouseEnter={(e) => {
                // nothing to say on an empty day, and a dimmed one is AFTER
                // the time machine's date: showing its count would leak the
                // future that the dimming is there to hide
                if (c === 0 || dimmed) return;
                setWrap(e.currentTarget);
                setHoverDay(iso);
              }}
              onMouseLeave={() => {
                setHoverDay(null);
                clearTip();
              }}
            />
          );
        })}
        </svg>
      </div>
      {hoverDay && hoverStats && (
        <div ref={tipRef} className="bar-tip" style={tipStyle}>
          <div className="bar-tip-row">
            <b className="bar-tip-title">
              {hoverDay === todayIso ? "Today" : fmtDate(hoverDay)}
            </b>
            <b>+{fmtNum(byDay.get(hoverDay) ?? 0)}</b>&nbsp;clears
          </div>
          {/* zero rows dropped, like the gauges of the other tooltips: a day
              with no FC has nothing to say about FCs */}
          {hoverStats.fc > 0 && (
            <div className="bar-tip-row">
              <span className="gauge-dot" style={{ background: "var(--yellow)" }} /> FC{" "}
              <b>+{fmtNum(hoverStats.fc)}</b>
            </div>
          )}
          {hoverStats.ranked > 0 && (
            <div className="bar-tip-row">
              <span className="gauge-dot" style={{ background: "var(--accent)" }} /> Ranked{" "}
              <b>+{fmtCompact(hoverStats.ranked)}</b>
            </div>
          )}
          {hoverGrades.length > 0 && (
            <div className="bar-tip-row hm-tip-grades">
              {hoverGrades.map((g) => (
                <span key={g.tier} className="hm-day-grade">
                  <GradeBadge grade={g.tier} width={22} />
                  <b className={g.d < 0 ? "val-neg" : "val-pos"}>
                    {g.d > 0 ? `+${g.d}` : g.d}
                  </b>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="hm-legend">
        <span className="dim">New clears / day</span>
        <span className="hm-legend-label">0</span>
        {/* the gradient bar is built from the SAME function as the cells */}
        <span
          className="hm-legend-bar"
          style={{
            background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1]
              .map((f) => cellColor(f * CELL_MAX))
              .join(", ")})`,
          }}
        />
        <span className="hm-legend-label">{CELL_MAX}+</span>
      </div>
      </div>

        {(sel != null || ruleset !== 0) && (
          <div className="hm-day fade-swap" key={selDay}>
            <div className="hm-day-head">
              <b>{selDay === todayIso ? "Today" : fmtDate(selDay)}</b>
              {selDay !== todayIso && (
                <button className="hm-day-today" onClick={() => setSelDay(todayIso)}>
                  today
                </button>
              )}
            </div>
            {sel == null ? null : sel.clears === 0 && sel.fc === 0 && sel.ranked === 0 && gradeDeltas.length === 0 && daySc.length === 0 ? (
              <div className="hm-day-empty">No clears</div>
            ) : (
              <>
                {(sel.clears > 0 || sel.fc > 0 || sel.ranked > 0 || dayAgg.stdGained > 0) && (
                <div className="hm-day-summary">
                  <span>
                    <b>+{fmtNum(sel.clears)}</b> clears
                  </span>
                  <span>
                    <b>+{fmtNum(sel.fc)}</b> FC
                  </span>
                  <span>
                    <b>+{fmtNum(sel.ranked)}</b> ranked
                  </span>
                  {dayAgg.stdGained > 0 && (
                    <span>
                      <b>+{fmtNum(dayAgg.stdGained)}</b> standardised
                    </span>
                  )}
                </div>
                )}
                {daySc.length > 0 && (
                  <div className="hm-day-summary hm-day-summary-sub">
                    <span>
                      <b>{fmtNum(daySc.length)}</b> scores
                    </span>
                    {daySc.filter((p) => p.best === 1).length > 0 && (
                      <span>
                        <b>+{fmtNum(daySc.filter((p) => p.best === 1).length)}</b> bests
                      </span>
                    )}
                    {dayAgg.inMapSec > 0 && (
                      <span>
                        <b>{Math.floor(dayAgg.inMapSec / 3600) > 0 ? `${Math.floor(dayAgg.inMapSec / 3600)}h${String(Math.floor((dayAgg.inMapSec % 3600) / 60)).padStart(2, "0")}` : `${Math.floor(dayAgg.inMapSec / 60)}min`}</b> in map
                      </span>
                    )}
                    {dayAgg.avgAcc != null && (
                      <span>
                        <b>{(dayAgg.avgAcc * 100).toFixed(2)}%</b> avg acc
                      </span>
                    )}
                    {dayAgg.bestPp != null && (
                      <span>
                        <b>{dayAgg.bestPpEst ? "~" : ""}{dayAgg.bestPp.toFixed(2)}pp</b> best
                      </span>
                    )}
                  </div>
                )}
                {gradeDeltas.length > 0 && (
                  <div className="hm-day-grades">
                    {gradeDeltas.map((g) => (
                      <span key={g.tier} className="hm-day-grade">
                        <GradeBadge grade={g.tier} width={26} />
                        <b className={g.d < 0 ? "val-neg" : "val-pos"}>
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
                          ["time", "Time"],
                          ["grade", "Grade"],
                          ["title", "Map"],
                          ["sr", "★"],
                          ["acc", "Acc"],
                        ] as const
                      ).map(([key, label]) => (
                        <th
                          key={key}
                          className={sortKey === key ? "on" : ""}
                          onClick={() => setSort(key)}
                        >
                          {label}
                          {sortKey === key ? (sortDesc ? " ▼" : " ▲") : ""}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r) => (
                      <tr
                        key={r.beatmap_id}
                        title={`${r.artist} - ${r.title} [${r.version}] · ${(r.accuracy * 100).toFixed(2)}%`}
                        onDoubleClick={() =>
                          window.open(mapUrl(r.beatmap_id, ruleset), "_blank")
                        }
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setCtx({ x: e.clientX, y: e.clientY, row: r });
                        }}
                      >
                        <td className="hm-day-map-time">
                          {new Date(r.ended_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </td>
                        <td>
                          <GradeBadge grade={r.rank} width={24} />
                        </td>
                        <td className="hm-day-map-name">
                          <div className="hm-day-map-cell">
                            <span className="hm-day-map-title">
                              {r.artist} - {r.title} <i>[{r.version}]</i>
                            </span>
                            {(modsLabel(r.mods) || (r.rate != null && r.rate !== 1)) && (
                              <span className="hm-day-map-mods">
                                {modsLabel(r.mods) ? `+${modsLabel(r.mods)}` : ""}
                                {r.rate != null && r.rate !== 1
                                  ? `${modsLabel(r.mods) ? " " : ""}${r.rate}x`
                                  : ""}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={`hm-day-map-sr${r.sr_mods != null ? " sr-mod" : ""}`}>
                          {(r.sr_mods ?? r.star_rating) != null
                            ? (r.sr_mods ?? r.star_rating)!.toFixed(2)
                            : "—"}
                        </td>
                        <td className="hm-day-map-acc">
                          {(r.accuracy * 100).toFixed(2)}%
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
      {/* the selected day unfolded over the full panel width: one dot per
          play across 24h, the active spans shaded */}
      {daySc.length > 1 && (
        <div className="hm-intraday fade-swap" key={`i-${selDay}`}>
          <div className="hm-intraday-head">
            <b>{selDay === todayIso ? "Today" : fmtDate(selDay)}</b>
            <span>day timeline</span>
          </div>
          <PlayScatter
            scores={daySc}
            bands={dayBands}
            domain={[Date.parse(dayStart), Date.parse(dayStart) + 86_400_000]}
            onOpen={setModalId}
            wide
          />
        </div>
      )}
      {ctx && (
        <>
          <div
            className="ctx-overlay"
            onClick={() => setCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx(null);
            }}
          />
          <div className="ctx-menu" style={ctxMenuStyle(ctx.x, ctx.y)}>
            <div className="ctx-title">
              {ctx.row.artist} – {ctx.row.title} [{ctx.row.version}]
            </div>
            <button
              onClick={() => {
                setModalId(ctx.row.beatmap_id);
                setCtx(null);
              }}
            >
              Map details
            </button>
            <button
              onClick={() => {
                window.open(mapUrl(ctx.row.beatmap_id, ruleset), "_blank");
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
      {modalId != null && (
        <MapModal beatmapId={modalId} ruleset={ruleset} onClose={() => setModalId(null)} />
      )}
    </div>
  );
});

