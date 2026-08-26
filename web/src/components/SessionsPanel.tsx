import { memo, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchSessions,
  fetchSessionScores,
  type DashScope,
  type SessionEntry,
  type SessionScore,
} from "../api";
import { ctxMenuStyle } from "../ctxmenu";
import { displayGrade, fmtCompact, fmtDate, fmtNum, fmtTime } from "../format";
import { mapUrl } from "../rulesets";
import { GRADE_ORDER, type PoolMode } from "../types";
import { GradeBadge } from "./GradeBadge";
import { MapModal } from "./MapModal";
import { PlayScatter } from "./PlayScatter";

/** "1h07" / "23m" from seconds */
const dur = (sec: number) => {
  const m = Math.round(sec / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`
    : `${m}m`;
};
const hm = (iso: string) => fmtTime(iso).slice(0, 5);

/** a pause longer than this between two plays counts as a break */
const BREAK_MS = 5 * 60_000;

const modsText = (raw: string): string => {
  try {
    const m = JSON.parse(raw) as { acronym: string }[];
    return m.length ? m.map((x) => x.acronym).join(" ") : "";
  } catch {
    return "";
  }
};

const GRADE_RANK: Record<string, number> = {
  XH: 7, X: 6, SH: 5, S: 4, A: 3, B: 2, C: 1, D: 0,
};

/** sortable columns of the session's score list — same idiom as the map
 * modal's table (click to sort, click again to flip) */
const SC_COLS: {
  id: string;
  label: string;
  num?: boolean;
  key: (s: SessionScore) => number | string | null;
}[] = [
  { id: "time", label: "Time", key: (s) => s.at },
  { id: "grade", label: "Grade", key: (s) => GRADE_RANK[s.rank] ?? -1 },
  { id: "map", label: "Map", key: (s) => `${s.artist} ${s.title}` },
  { id: "mods", label: "Mods", key: (s) => modsText(s.mods) },
  { id: "sr", label: "Stars", num: true, key: (s) => s.sr_mods ?? s.sr },
  { id: "acc", label: "Acc", num: true, key: (s) => s.accuracy },
  { id: "score", label: "Score", num: true, key: (s) => s.classic ?? s.std },
  { id: "pp", label: "pp", num: true, key: (s) => s.pp },
];

/** sortable columns of the session list */
const COLS: {
  id: string;
  label: string;
  num?: boolean;
  key: (s: SessionEntry) => number | string | null;
}[] = [
  { id: "date", label: "Date", key: (s) => s.start },
  { id: "dur", label: "Duration", num: true, key: (s) => s.sec },
  { id: "plays", label: "Plays", num: true, key: (s) => s.plays },
  { id: "score", label: "Score", num: true, key: (s) => s.classic },
  { id: "pp", label: "Best pp", num: true, key: (s) => s.maxPp },
];
const PAGE = 100;

/**
 * The scores of ONE session, with the aggregates the list cannot show:
 * grade spread, score/pp totals and bests, breaks. Every score row opens
 * its map.
 */
function SessionDetail({
  session,
  ruleset,
  pool,
  keys,
  scope,
}: {
  session: SessionEntry;
  ruleset: number;
  pool: PoolMode;
  keys: string[];
  scope: DashScope;
}) {
  const { data } = useQuery({
    queryKey: ["session-scores", session.start, session.end, ruleset, pool, keys, scope],
    queryFn: () => fetchSessionScores(session.start, session.end, ruleset, pool, keys, scope),
  });
  const [modalId, setModalId] = useState<number | null>(null);
  const [scSort, setScSort] = useState({ id: "time", desc: false });
  // same right-click menu as the maps table rows
  const [ctx, setCtx] = useState<{ x: number; y: number; s: SessionScore } | null>(null);
  if (!data) return <div className="sess-detail-empty">Loading session…</div>;
  const sc = data.scores;
  const scCol = SC_COLS.find((c) => c.id === scSort.id) ?? SC_COLS[0];
  const scSorted = [...sc].sort((a, b) => {
    const x = scCol.key(a);
    const y = scCol.key(b);
    if (x == null) return y == null ? 0 : 1; // nulls last, both directions
    if (y == null) return -1;
    const cmp =
      typeof x === "string" ? x.localeCompare(String(y)) : Number(x) - Number(y);
    return scSort.desc ? -cmp : cmp;
  });
  const grades = new Map<string, number>();
  for (const s of sc) grades.set(s.rank, (grades.get(s.rank) ?? 0) + 1);
  const passes = sc.filter((s) => s.passed);
  const sum = (v: (x: (typeof sc)[number]) => number | null) =>
    sc.reduce((a, x) => a + (v(x) ?? 0), 0);
  const max = (v: (x: (typeof sc)[number]) => number | null) =>
    sc.reduce<number | null>((a, x) => {
      const n = v(x);
      return n != null && (a == null || n > a) ? n : a;
    }, null);
  const classicTotal = sum((x) => (x.passed ? (x.classic ?? x.std) : 0));
  const stdTotal = sum((x) => (x.passed ? x.std : 0));
  const ppTotal = sum((x) => x.pp);
  const ppMax = max((x) => x.pp);
  const ppCount = sc.filter((x) => x.pp != null).length;
  // breaks: idle time between one play's end and the next one's start
  // (next end minus its own length), when it exceeds five minutes — the
  // spans shade the chart behind the dots
  let breaks = 0;
  let breakSec = 0;
  let longestBreak = 0;
  const breakSpans: { from: number; to: number }[] = [];
  for (let i = 1; i < sc.length; i++) {
    const idle =
      (Date.parse(sc[i].at) - Date.parse(sc[i - 1].at)) / 1000 - (sc[i].len ?? 0);
    if (idle * 1000 > BREAK_MS) {
      breaks++;
      breakSec += idle;
      longestBreak = Math.max(longestBreak, idle);
      breakSpans.push({
        from: Date.parse(sc[i - 1].at),
        to: Date.parse(sc[i].at) - (sc[i].len ?? 0) * 1000,
      });
    }
  }
  const tiles: [string, string][] = [
    ["Duration", dur(session.sec)],
    ["Scores", fmtNum(sc.length)],
    ["Classic gained", fmtNum(classicTotal)],
    ["Avg classic", passes.length ? fmtNum(Math.round(classicTotal / passes.length)) : "—"],
    ["Standardised gained", fmtNum(stdTotal)],
    ["Total pp", ppCount ? `${fmtNum(Math.round(ppTotal))}pp` : "—"],
    ["Avg pp", ppCount ? `${Math.round(ppTotal / ppCount)}pp` : "—"],
    ["Best pp", ppMax != null ? `${ppMax.toFixed(2)}pp` : "—"],
    ["Breaks", breaks > 0 ? `${breaks} · ${dur(breakSec)}` : "none"],
    ["Longest break", breaks > 0 ? dur(longestBreak) : "—"],
  ];
  return (
    <div className="sess-detail">
      <div className="sess-detail-head">
        <b>{fmtDate(session.start)}</b>
        <span>
          {hm(session.start)} → {hm(session.end)}
        </span>
        <div className="sess-grades">
          {/* only the grades this session actually earned, big enough to read */}
          {GRADE_ORDER.filter((g) => (grades.get(g) ?? 0) > 0).map((g) => (
            <span key={g} className="sess-grade" title={displayGrade(g)}>
              <GradeBadge grade={g} width={46} title={displayGrade(g)} />
              <b className="val-pos">+{fmtNum(grades.get(g) ?? 0)}</b>
            </span>
          ))}
        </div>
      </div>
      <div className="sess-tiles">
        {tiles.map(([k, v]) => (
          <div key={k} className="strip-tile">
            <span>{k}</span>
            <b>{v}</b>
          </div>
        ))}
      </div>
      {sc.length > 1 && (
        <PlayScatter
          scores={sc}
          bands={breakSpans.map((b) => ({ ...b, kind: "break" as const }))}
          onOpen={setModalId}
        />
      )}
      <div className="sess-scores">
        <div className="sess-score sess-sc-head">
          {SC_COLS.map((c) => (
            <button
              key={c.id}
              className={`sess-th ${c.num ? "num" : ""}`}
              title="Click to sort"
              onClick={() =>
                setScSort((p) =>
                  p.id === c.id ? { id: c.id, desc: !p.desc } : { id: c.id, desc: true }
                )
              }
            >
              {c.label}
              {scSort.id === c.id ? (scSort.desc ? " ▼" : " ▲") : ""}
            </button>
          ))}
        </div>
        {scSorted.map((s) => (
          <div
            key={s.id}
            className="sess-score"
            title="Double-click: open on osu.ppy.sh · right-click: actions"
            onDoubleClick={() => window.open(mapUrl(s.mapId, ruleset), "_blank")}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, s });
            }}
          >
            <span className="sess-sc-time">{hm(s.at)}</span>
            <GradeBadge grade={s.rank} width={30} title={displayGrade(s.rank)} />
            <span className="sess-sc-map">
              {s.artist} – {s.title} <i>[{s.diff}]</i>
            </span>
            <span className="sess-sc-mods">
              {modsText(s.mods)}
              {s.rate != null && s.rate !== 1 ? ` ${s.rate}x` : ""}
            </span>
            <span className={`num${s.sr_mods != null ? " sr-mod" : ""}`}>
              {(s.sr_mods ?? s.sr) != null ? `${(s.sr_mods ?? s.sr)!.toFixed(2)}★` : ""}
            </span>
            <span className="num">{(s.accuracy * 100).toFixed(2)}%</span>
            <span className="num">{fmtNum(s.classic ?? s.std)}</span>
            <span className="num">{s.pp != null ? `${s.pp.toFixed(2)}pp` : ""}</span>
          </div>
        ))}
      </div>
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
              {ctx.s.artist} – {ctx.s.title} [{ctx.s.diff}]
            </div>
            <button
              onClick={() => {
                setModalId(ctx.s.mapId);
                setCtx(null);
              }}
            >
              Map details
            </button>
            <button
              onClick={() => {
                window.open(mapUrl(ctx.s.mapId, ruleset), "_blank");
                setCtx(null);
              }}
            >
              Open on osu.ppy.sh
            </button>
            <button
              onClick={() => {
                window.location.href = `osu://b/${ctx.s.mapId}`;
                setCtx(null);
              }}
            >
              Open in osu! (osu!direct)
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(String(ctx.s.mapId));
                setCtx(null);
              }}
            >
              Copy beatmap id
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(
                  `${ctx.s.artist} - ${ctx.s.title} [${ctx.s.diff}]`
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
}

/**
 * Play sessions, reconstructed server-side from the score timestamps (fails
 * included, split on a one-hour silence). Master list (sortable, filterable,
 * paged) on the left, the selected session unfolded on the right. All-time
 * like the records, so the whole panel dims under the time machine.
 */
export const SessionsPanel = memo(function SessionsPanel({
  ruleset = 0,
  pool = "all",
  keys = [],
  scope = "all",
  dimmed = false,
}: {
  ruleset?: number;
  pool?: PoolMode;
  keys?: string[];
  scope?: DashScope;
  dimmed?: boolean;
}) {
  // session split, persisted: how long a silence starts a new sitting
  const [gapMin, setGapMinState] = useState(() => {
    const v = Number(localStorage.getItem("sess-gap"));
    return Number.isFinite(v) && v > 0 ? v : 60;
  });
  const setGapMin = (v: number) => {
    localStorage.setItem("sess-gap", String(v));
    setGapMinState(v);
  };
  const { data } = useQuery({
    queryKey: ["sessions", ruleset, pool, keys, scope, gapMin],
    queryFn: () => fetchSessions(ruleset, pool, keys, scope, gapMin),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const [sort, setSort] = useState({ id: "date", desc: true });
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<SessionEntry | null>(null);
  const shown = useMemo(() => {
    const col = COLS.find((c) => c.id === sort.id) ?? COLS[0];
    return [...(data?.sessions ?? [])]
      .sort((a, b) => {
        const x = col.key(a);
        const y = col.key(b);
        if (x == null) return y == null ? 0 : 1; // nulls last, both directions
        if (y == null) return -1;
        const cmp =
          typeof x === "string" ? x.localeCompare(String(y)) : Number(x) - Number(y);
        return sort.desc ? -cmp : cmp;
      });
  }, [data?.sessions, sort]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const pageSafe = Math.min(page, pages - 1);
  // the latest session opens by itself: the tab never lands on an empty pane
  useEffect(() => {
    if (sel == null && data && data.sessions.length > 0) setSel(data.sessions[0]);
  }, [sel, data]);
  if (!data) return <div className="panel">Loading sessions…</div>;
  const s = data.summary;
  if (s.count === 0)
    return <div className="panel">No session yet: sessions appear as scores land.</div>;
  return (
    <div className={`panel sessions-panel${dimmed ? " tm-dim" : ""}`}>
      <div className="sess-summary">
        <h3>Sessions</h3>
        <span className="mm-stat"><b>{fmtNum(s.count)}</b> sessions</span>
        <span className="mm-stat">longest <b>{dur(s.longestSec)}</b></span>
        <span className="mm-stat">average <b>{dur(s.avgSec)}</b></span>
        <span className="mm-stat"><b>{s.avgPlays.toFixed(1)}</b> plays / session</span>
        <label className="sess-gap" title="A longer silence than this starts a new session">
          split after
          <select value={gapMin} onChange={(e) => setGapMin(Number(e.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((g) => (
              <option key={g} value={g}>{g} min</option>
            ))}
          </select>
        </label>
      </div>
      <div className="sess-layout">
        <div className="sess-master">
          <div className="sess-tools">
            <div className="sess-pager">
              <button disabled={pageSafe === 0} onClick={() => setPage(pageSafe - 1)}>
                ‹
              </button>
              <span>
                {pageSafe + 1} / {pages}
              </span>
              <button
                disabled={pageSafe >= pages - 1}
                onClick={() => setPage(pageSafe + 1)}
              >
                ›
              </button>
            </div>
          </div>
          <div className="sess-rows">
          <div className="sess-row sess-head">
            {COLS.map((c) => (
              <button
                key={c.id}
                className={`sess-th ${c.num ? "num" : ""} ${sort.id === c.id ? "on" : ""}`}
                title="Click to sort"
                onClick={() => {
                  setSort((p) =>
                    p.id === c.id ? { id: c.id, desc: !p.desc } : { id: c.id, desc: true }
                  );
                  setPage(0);
                }}
              >
                {c.label}
                {sort.id === c.id ? (sort.desc ? " ▼" : " ▲") : ""}
              </button>
            ))}
          </div>
          {shown.slice(pageSafe * PAGE, pageSafe * PAGE + PAGE).map((x) => (
            <div
              key={x.start}
              className={`sess-row${sel?.start === x.start ? " sel" : ""}`}
              onClick={() => setSel(x)}
            >
              <span>
                {fmtDate(x.start)} <i>{hm(x.start)}</i>
              </span>
              <span className="num">{dur(x.sec)}</span>
              <span className="num">{fmtNum(x.plays)}</span>
              <span className="num">{x.classic > 0 ? fmtCompact(x.classic) : "—"}</span>
              <span className="num">{x.maxPp != null ? `${x.maxPp.toFixed(2)}pp` : "—"}</span>
            </div>
          ))}
          </div>
        </div>
        {sel != null && (
          <SessionDetail
            session={sel}
            ruleset={ruleset}
            pool={pool}
            keys={keys}
            scope={scope}
          />
        )}
      </div>
    </div>
  );
});
