import { memo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus, fetchRecords, fetchSessions, type DashScope } from "../api";
import { fmtNum } from "../format";
import type { PoolMode } from "../types";
import { useDisplayPrefs } from "../prefs";
import { witherLevel, witherXpTotal } from "../wither";

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const hours = (s: number) =>
  `${fmtNum(Math.floor(s / 3600))}h ${Math.floor((s % 3600) / 60)}m`;

/**
 * The all-time figures row inside the hero: pool aggregates from /records
 * plus the osu! profile numbers when the account is connected. All-time like
 * the records, so it dims under the time machine.
 */
export const StatsStrip = memo(function StatsStrip({
  ruleset = 0,
  pool = "all",
  keys = [],
  scope = "all",
  dimmed = false,
  at = null,
  completion = null,
  grades = [],
  rankedClassic = null,
}: {
  ruleset?: number;
  pool?: PoolMode;
  keys?: string[];
  scope?: DashScope;
  dimmed?: boolean;
  /** time machine day: tracker aggregates as of that evening (null = live);
   * profile-sourced tiles have no history and hide */
  at?: string | null;
  /** live played/total of the current scope, for the Completion tile */
  completion?: { done: number; total: number } | null;
  /** live grade counts of the bests, for the wither XP composite */
  grades?: { grade: string; c: number }[];
  /** the tracker's ranked classic sum — same number as the hero, the
   * profile's own ranked_score drifts from it (different pool) */
  rankedClassic?: number | null;
}) {
  const { data } = useQuery({
    queryKey: ["records", ruleset, pool, keys, scope, at],
    queryFn: () => fetchRecords(ruleset, pool, keys, scope, at),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const { data: auth } = useQuery({
    queryKey: ["auth", ruleset],
    queryFn: () => fetchAuthStatus(ruleset),
  });
  const { data: sess } = useQuery({
    queryKey: ["sessions", ruleset, pool, keys, scope],
    queryFn: () => fetchSessions(ruleset, pool, keys, scope),
    refetchInterval: 60_000,
  });
  const prefs = useDisplayPrefs();
  if (!data?.stats || !data.averages) return null;
  const st = data.stats;
  const a = data.averages;
  // under the time machine, only the tracker's own aggregates exist: the
  // profile figures and the sessions are today's numbers, so they hide
  const tm = at != null;
  const ps = tm ? undefined : auth?.profile?.stats;
  const dc = tm ? undefined : auth?.profile?.daily_challenge;
  const gradeMap = new Map(grades.map((gr) => [gr.grade, gr.c]));
  const xp = ps
    ? witherXpTotal((k) => gradeMap.get(k) ?? 0, ps)
    : null;
  const weighted = prefs.estPerf ? st.weightedPp : st.weightedPpOfficial;
  const tiles: [string, ReactNode | null][] = [
    ["Scores", fmtNum(st.scores)],
    [
      "Clears",
      completion && completion.total > 0 ? (
        <>
          {fmtNum(a.clears)}
          <i className="strip-sub"> / {fmtNum(completion.total)}</i>
        </>
      ) : (
        fmtNum(a.clears)
      ),
    ],
    [
      "Completion",
      completion && completion.total > 0
        ? `${((completion.done / completion.total) * 100).toFixed(2)}%`
        : null,
    ],
    ["Play count", ps ? fmtNum(ps.play_count) : null],
    ["Play time", ps ? hours(ps.play_time) : null],
    // the nomod length of every cleared map, counted once — how much of the
    // catalog's runtime has been cleared, regardless of the mods used
    [
      "Clear time",
      st.clearTime != null ? (
        st.catalogTime != null && st.catalogTime > 0 ? (
          <>
            {fmtNum(Math.round(st.clearTime / 3600))}h
            <i className="strip-sub"> / {fmtNum(Math.round(st.catalogTime / 3600))}h</i>
          </>
        ) : (
          hours(st.clearTime)
        )
      ) : null,
    ],
    // completion stays count-based (the completionist metric); this is the
    // same idea weighted by content length instead of map count
    [
      "Time completion",
      st.clearTime != null && st.catalogTime != null && st.catalogTime > 0
        ? `${((st.clearTime / st.catalogTime) * 100).toFixed(2)}%`
        : null,
    ],
    ["Sessions", !tm && sess && sess.summary.count > 0 ? fmtNum(sess.summary.count) : null],
    [
      "Longest session",
      !tm && sess && sess.summary.count > 0 ? hours(sess.summary.longestSec) : null,
    ],
    [
      "Avg session",
      !tm && sess && sess.summary.count > 0
        ? sess.summary.avgSec >= 3600
          ? hours(sess.summary.avgSec)
          : `${Math.round(sess.summary.avgSec / 60)} min`
        : null,
    ],
    ["Total performance", `${fmtNum(Math.round(st.totalPp))}pp`],
    ["Performance", `${fmtNum(Math.round(weighted ?? st.weightedPp))}pp`],
    ["Avg performance", st.avgPp != null ? `${Math.round(st.avgPp)}pp` : null],
    ["Avg accuracy", a.acc != null ? `${(a.acc * 100).toFixed(2)}%` : null],
    ["Avg length", a.len != null ? mmss(a.len) : null],
    ["Avg stars", a.sr != null ? `${a.sr.toFixed(2)}★` : null],
    ["FC rate", a.clears > 0 ? `${((a.fc / a.clears) * 100).toFixed(1)}%` : null],
    [
      "Score per clear",
      a.classic != null && a.clears > 0 ? fmtNum(Math.round(a.classic / a.clears)) : null,
    ],
    [
      "Ranked score",
      tm
        ? a.classic != null
          ? fmtNum(a.classic)
          : null
        : rankedClassic != null
          ? fmtNum(rankedClassic)
          : ps
            ? fmtNum(ps.ranked_score)
            : null,
    ],
    ["Total score", ps ? fmtNum(ps.total_score) : null],
    ["Standardised score", st.totalStd != null ? fmtNum(st.totalStd) : null],
    ["Medals", ps ? fmtNum(ps.medals) : null],
    ["Wither XP", prefs.wither && xp != null ? fmtNum(Math.round(xp)) : null],
    ["Wither level", prefs.wither && xp != null ? witherLevel(xp).toFixed(2) : null],
    [
      "Daily challenge",
      dc ? `${fmtNum(dc.playcount)} played` : null,
    ],
    [
      "DC streak",
      dc ? `${fmtNum(dc.daily_current)} · best ${fmtNum(dc.daily_best)}` : null,
    ],
  ];
  const shown = tiles.filter((t): t is [string, ReactNode] => t[1] != null);
  if (shown.length === 0) return null;
  return (
    <div className={`hero-strip${dimmed ? " tm-dim" : ""}`}>
      {shown.map(([label, value]) => (
        <div key={label} className="strip-tile">
          <span>{label}</span>
          <b>{value}</b>
        </div>
      ))}
    </div>
  );
});
