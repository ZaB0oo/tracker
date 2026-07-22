import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDaily } from "../api";
import { fmtDate, fmtNum } from "../format";

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

/**
 * GitHub-style clears-per-day heatmap + streak stats. When the time machine
 * selects a past day, later days are dimmed.
 */
export function HeatmapPanel({ cutoffDay = null }: { cutoffDay?: string | null }) {
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const { data } = useQuery({
    queryKey: ["daily", year],
    queryFn: () => fetchDaily(year),
    refetchInterval: 5 * 60_000,
  });
  if (!data) return null;

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
            >
              <title>{`${iso}: ${c} clear(s)`}</title>
            </rect>
          );
        })}
        </svg>
      </div>
    </div>
  );
}
