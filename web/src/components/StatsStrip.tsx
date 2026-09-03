import { StripSkeleton } from "./Skeleton";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
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
 * Value that counts up (or down) to its new value when it changes
 * (ease-out, ~700 ms) instead of jumping. `fmt` receives the ANIMATED raw
 * value and does its own rounding, so every tile can animate: integers,
 * percentages, durations, decimals. Reduced motion, or a first render,
 * shows the value directly.
 */
function CountNum({
  v,
  fmt = (n) => fmtNum(Math.round(n)),
}: {
  v: number;
  fmt?: (n: number) => string;
}) {
  const [disp, setDisp] = useState(v);
  const prevRef = useRef(v);
  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = v;
    if (from === v) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisp(v);
      return;
    }
    const t0 = performance.now();
    const dur = 700;
    let raf = 0;
    const step = (t: number) => {
      const f = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - f) ** 3;
      setDisp(from + (v - from) * e);
      if (f < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [v]);
  return <>{fmt(disp)}</>;
}

/**
 * One strip tile. `sig` is the tile's raw underlying value: when it changes
 * between renders (not on the first one), the tile plays a glow, so a new
 * best visibly lands in the stats. Tiles without a natural signature pass
 * undefined and never flash.
 */
function Tile({ label, sig, children }: { label: string; sig?: unknown; children: ReactNode }) {
  const prev = useRef<unknown>(undefined);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const before = prev.current;
    prev.current = sig;
    if (before === undefined || sig === undefined || before === sig) return;
    setOn(true);
    const t = setTimeout(() => setOn(false), 1400);
    return () => clearTimeout(t);
  }, [sig]);
  return (
    <div className={`strip-tile${on ? " strip-tile-flash" : ""}`}>
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

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
  const recQ = useQuery({
    queryKey: ["records", ruleset, pool, keys, scope, at],
    queryFn: () => fetchRecords(ruleset, pool, keys, scope, at),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const authQ = useQuery({
    queryKey: ["auth", ruleset],
    queryFn: () => fetchAuthStatus(ruleset),
    // the profile tiles (play count, play time, total score, medals, daily
    // challenge) must move too: without an interval they only refreshed on
    // window focus, so their count-up practically never played. The server
    // caches the profile (1 h, or until the next poll finds new scores), so
    // this stays one cheap local request per minute.
    refetchInterval: 60_000,
  });
  // same split setting as the Sessions tab (persisted there), so the tile
  // and the tab always count the same sittings; also shares its cache entry
  let gapRaw = NaN;
  try {
    gapRaw = Number(localStorage.getItem("sess-gap"));
  } catch {
    /* storage blocked: fall back to the default split */
  }
  const gapMin = Number.isFinite(gapRaw) && gapRaw > 0 ? gapRaw : 60;
  const sessQ = useQuery({
    queryKey: ["sessions", ruleset, pool, keys, scope, gapMin],
    queryFn: () => fetchSessions(ruleset, pool, keys, scope, gapMin),
    refetchInterval: 60_000,
  });
  const prefs = useDisplayPrefs();
  // Animations start TOGETHER: while any of the three sources is still
  // refetching, keep showing the previous snapshot; when the last response
  // lands, swap everything in one render. Without this, the records tiles
  // counted first, the profile ones half a second later, the session ones
  // last: the staggered waves the user reported.
  const fetching = recQ.isFetching || authQ.isFetching || sessQ.isFetching;
  const snapRef = useRef<{
    data: typeof recQ.data;
    auth: typeof authQ.data;
    sess: typeof sessQ.data;
  } | null>(null);
  if (!fetching || snapRef.current == null)
    snapRef.current = { data: recQ.data, auth: authQ.data, sess: sessQ.data };
  const { data, auth, sess } = snapRef.current;
  // shimmer while the aggregates load: this strip used to pop in from
  // nothing, shoving the panels below it down
  if (!data) return <StripSkeleton />;
  if (!data.stats || !data.averages) return null;
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
  const pct2 = (x: number) => `${x.toFixed(2)}%`;
  const pct1 = (x: number) => `${x.toFixed(1)}%`;
  // [label, rendered value, raw signature for the change glow] — EVERY tile
  // animates: fmt does the rounding, so percentages, durations and decimals
  // count up like the integers do
  const tiles: [string, ReactNode | null, unknown?][] = [
    ["Scores", <CountNum v={st.scores} />, st.scores],
    [
      "Clears",
      completion && completion.total > 0 ? (
        <>
          <CountNum v={a.clears} />
          <i className="strip-sub"> / {fmtNum(completion.total)}</i>
        </>
      ) : (
        <CountNum v={a.clears} />
      ),
      a.clears,
    ],
    [
      "Completion",
      completion && completion.total > 0
        ? <CountNum v={(completion.done / completion.total) * 100} fmt={pct2} />
        : null,
      completion?.done,
    ],
    ["Play count", ps ? <CountNum v={ps.play_count} /> : null, ps?.play_count],
    ["Play time", ps ? <CountNum v={ps.play_time} fmt={hours} /> : null, ps?.play_time],
    // the nomod length of every cleared map, counted once — how much of the
    // catalog's runtime has been cleared, regardless of the mods used
    [
      "Clear time",
      st.clearTime != null ? (
        st.catalogTime != null && st.catalogTime > 0 ? (
          <>
            <CountNum v={st.clearTime / 3600} fmt={(x) => `${fmtNum(Math.round(x))}h`} />
            <i className="strip-sub"> / {fmtNum(Math.round(st.catalogTime / 3600))}h</i>
          </>
        ) : (
          <CountNum v={st.clearTime} fmt={hours} />
        )
      ) : null,
      st.clearTime,
    ],
    // completion stays count-based (the completionist metric); this is the
    // same idea weighted by content length instead of map count
    [
      "Time completion",
      st.clearTime != null && st.catalogTime != null && st.catalogTime > 0
        ? <CountNum v={(st.clearTime / st.catalogTime) * 100} fmt={pct2} />
        : null,
      st.clearTime,
    ],
    [
      "Sessions",
      !tm && sess && sess.summary.count > 0 ? <CountNum v={sess.summary.count} /> : null,
      sess?.summary.count,
    ],
    [
      "Longest session",
      !tm && sess && sess.summary.count > 0
        ? <CountNum v={sess.summary.longestSec} fmt={hours} />
        : null,
      sess?.summary.longestSec,
    ],
    [
      "Avg session",
      !tm && sess && sess.summary.count > 0 ? (
        sess.summary.avgSec >= 3600 ? (
          <CountNum v={sess.summary.avgSec} fmt={hours} />
        ) : (
          <CountNum v={sess.summary.avgSec} fmt={(x) => `${Math.round(x / 60)} min`} />
        )
      ) : null,
      sess != null ? Math.round(sess.summary.avgSec) : undefined,
    ],
    [
      "Total performance",
      <>
        <CountNum v={st.totalPp} />pp
      </>,
      Math.round(st.totalPp),
    ],
    [
      "Performance",
      <>
        <CountNum v={weighted ?? st.weightedPp} />pp
      </>,
      Math.round(weighted ?? st.weightedPp),
    ],
    [
      "Avg performance",
      st.avgPp != null ? <CountNum v={st.avgPp} fmt={(x) => `${Math.round(x)}pp`} /> : null,
      st.avgPp != null ? Math.round(st.avgPp) : undefined,
    ],
    [
      "Avg accuracy",
      a.acc != null ? <CountNum v={a.acc * 100} fmt={pct2} /> : null,
      a.acc,
    ],
    ["Avg length", a.len != null ? <CountNum v={a.len} fmt={mmss} /> : null, a.len],
    [
      "Avg stars",
      a.sr != null ? <CountNum v={a.sr} fmt={(x) => `${x.toFixed(2)}★`} /> : null,
      a.sr,
    ],
    [
      "FC rate",
      a.clears > 0 ? <CountNum v={(a.fc / a.clears) * 100} fmt={pct1} /> : null,
      a.fc,
    ],
    [
      "Score per clear",
      a.classic != null && a.clears > 0 ? <CountNum v={a.classic / a.clears} /> : null,
      a.clears > 0 && a.classic != null ? Math.round(a.classic / a.clears) : undefined,
    ],
    [
      "Ranked score",
      tm
        ? a.classic != null
          ? <CountNum v={a.classic} />
          : null
        : rankedClassic != null
          ? <CountNum v={rankedClassic} />
          : ps
            ? <CountNum v={ps.ranked_score} />
            : null,
      tm ? a.classic : rankedClassic ?? ps?.ranked_score,
    ],
    ["Total score", ps ? <CountNum v={ps.total_score} /> : null, ps?.total_score],
    [
      "Standardised score",
      st.totalStd != null ? <CountNum v={st.totalStd} /> : null,
      st.totalStd,
    ],
    ["Medals", ps ? <CountNum v={ps.medals} /> : null, ps?.medals],
    [
      "Wither XP",
      prefs.wither && xp != null ? <CountNum v={xp} /> : null,
      prefs.wither && xp != null ? Math.round(xp) : undefined,
    ],
    [
      "Wither level",
      prefs.wither && xp != null
        ? <CountNum v={witherLevel(xp)} fmt={(x) => x.toFixed(2)} />
        : null,
      prefs.wither && xp != null ? witherLevel(xp).toFixed(2) : undefined,
    ],
    [
      "Daily challenge",
      dc ? <CountNum v={dc.playcount} fmt={(x) => `${fmtNum(Math.round(x))} played`} /> : null,
      dc?.playcount,
    ],
    [
      "DC streak",
      dc ? (
        <>
          <CountNum v={dc.daily_current} /> · best <CountNum v={dc.daily_best} />
        </>
      ) : null,
      dc?.daily_current,
    ],
  ];
  const shown = tiles.filter(
    (t): t is [string, ReactNode, unknown?] => t[1] != null
  );
  if (shown.length === 0) return null;
  return (
    <div className={`hero-strip${dimmed ? " tm-dim" : ""}`}>
      {shown.map(([label, value, sig]) => (
        // scope in the key: switching ruleset/pool/day remounts the tiles,
        // so the glow only ever means "this number just moved", never
        // "you are looking at a different pool now"
        <Tile
          key={`${ruleset}·${pool}·${keys.join("")}·${scope}·${at ?? ""}·${label}`}
          label={label}
          sig={sig}
        >
          {value}
        </Tile>
      ))}
    </div>
  );
});
