import { useState } from "react";
import { mapUrl } from "../rulesets";
import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchClears, fetchCountryHistory, fetchGlobalHistory } from "../api";
import { firstPlaceLabel, useCountryCode } from "../country";
import { ctxMenuStyle } from "../ctxmenu";
import { displayGrade, fmtDateTime, fmtNum } from "../format";
import { GradeBadge } from "./GradeBadge";
import { MapModal } from "./MapModal";
import { FC_LABELS } from "../types";

/** Shared placeholder: the three history tabs page over big tables. */
function HistorySkeleton() {
  return (
    <div className="hist-skeleton">
      {[...Array(10)].map((_, i) => (
        <div key={i} className="skeleton skeleton-row" />
      ))}
    </div>
  );
}

const PAGE = 100;

/** Map identity carried by every history row (context menu / details). */
interface CtxMapInfo {
  beatmap_id: number;
  artist: string;
  title: string;
  version: string;
}
type OnMapContext = (e: React.MouseEvent, info: CtxMapInfo) => void;

/** "YYYY-MM-DD HH:MM:SS" (UTC SQLite) or ISO -> readable local time */
const fmtDate = (at: string) => {
  const iso = at.includes("T") ? at : at.replace(" ", "T") + "Z";
  return fmtDateTime(iso);
};
const fmtInt = (n: number | null | undefined) => (n == null ? "—" : fmtNum(n));

/**
 * Column headers. Rendered by the PANEL rather than by the list, so they sit
 * in the same sticky block as the filters above them — two stacked sticky
 * rows would need the second to hardcode the first one's height. Side effect:
 * they now stay visible while a list is loading or empty, which is what a
 * table header does anyway.
 */
function ClearsHeader() {
  return (
    <div className="hist-header">
      <span className="fr-event-date">Date</span>
      <span className="fr-event-badge">Grade</span>
      <span className="fr-event-map">Map</span>
      <span className="fc">FC</span>
      <span className="fr-event-score">Score</span>
      <span className="fr-event-acc">Acc</span>
    </div>
  );
}
function EventsHeader({ by }: { by: string }) {
  return (
    <div className="hist-header">
      <span className="fr-event-date">Date</span>
      <span className="fr-event-badge">Event</span>
      <span className="fr-event-map">Map</span>
      <span className="fr-event-by">{by}</span>
    </div>
  );
}

function ClearsList({ onCtx, ruleset }: { onCtx: OnMapContext; ruleset: number }) {
  const query = useInfiniteQuery({
    queryKey: ["clears", ruleset],
    queryFn: ({ pageParam }) => fetchClears(pageParam, PAGE, undefined, ruleset),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    refetchInterval: 60_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];

  if (query.isLoading) return <HistorySkeleton />;
  if (rows.length === 0)
    return <p className="goal-note">No score in the database yet.</p>;

  return (
    <>
      {rows.map((c, i) => (
        <div
          key={c.id}
          className={`fr-event${i % 2 ? " row-alt" : ""}${(c as { best?: number }).best ? " row-best" : ""}`}
          onDoubleClick={() =>
            window.open(mapUrl(c.beatmap_id, ruleset), "_blank")
          }
          onContextMenu={(e) => onCtx(e, c)}
          title="Double-click: open on osu.ppy.sh · right-click: actions"
        >
          <span className="fr-event-date">{fmtDate(c.ended_at)}</span>
          <span className="fr-event-badge">
            <GradeBadge grade={c.rank} width={36} title={displayGrade(c.rank)} />
          </span>
          <span className="fr-event-map">
            {c.artist} – {c.title}{" "}
            <span className="fr-event-diff">[{c.version}]</span>{" "}
            <span className="fr-event-sr">
              {c.star_rating != null ? `${c.star_rating.toFixed(2)}★` : ""}
            </span>
          </span>
          <span className={`fc fc-${c.fc_state}`}>{FC_LABELS[c.fc_state]}</span>
          <span className="fr-event-score">
            {fmtInt(c.classic_total_score ?? c.total_score)}
          </span>
          <span className="fr-event-acc">{(c.accuracy * 100).toFixed(2)}%</span>
        </div>
      ))}
      {query.hasNextPage && (
        <button
          style={{ marginTop: 10 }}
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          Load more
        </button>
      )}
    </>
  );
}

function CountryList({
  filter,
  onCtx,
  ruleset,
}: {
  filter: "" | "gained" | "lost";
  onCtx: OnMapContext;
  ruleset: number;
}) {
  const query = useInfiniteQuery({
    queryKey: ["country-history", filter, ruleset],
    queryFn: ({ pageParam }) =>
      fetchCountryHistory(pageParam, PAGE, filter || undefined, ruleset),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    refetchInterval: 60_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];

  if (query.isLoading) return <HistorySkeleton />;
  if (rows.length === 0)
    return (
      <p className="goal-note">
        No event yet. Transitions are logged as checks happen (new score →
        immediate check, held #1s → daily re-check). The initial sweep sets the
        state without filling the history.
      </p>
    );

  return (
    <>
      {rows.map((e, i) => (
        <div
          key={e.id}
          className={`fr-event fr-event-${e.event}${i % 2 ? " row-alt" : ""}`}
          onDoubleClick={() =>
            window.open(mapUrl(e.beatmap_id, ruleset), "_blank")
          }
          onContextMenu={(ev) => onCtx(ev, e)}
          title="Double-click: open on osu.ppy.sh · right-click: actions"
        >
          <span
            className="fr-event-date"
            title={`Detected on ${fmtDate(e.at)}${e.score_at ? ` · score set on ${fmtDate(e.score_at)}` : ""}`}
          >
            {fmtDate(e.score_at ?? e.at)}
          </span>
          <span className={`fr-event-badge ${e.event}`}>
            {e.event === "gained" ? "GAINED" : "LOST"}
          </span>
          <span className="fr-event-map">
            {e.artist} – {e.title}{" "}
            <span className="fr-event-diff">[{e.version}]</span>{" "}
            <span className="fr-event-sr">
              {e.star_rating != null ? `${e.star_rating.toFixed(2)}★` : ""}
            </span>
          </span>
          <span className="fr-event-by">
            {e.event === "lost"
              ? e.by_user_id
                ? (
                    <a
                      href={`https://osu.ppy.sh/users/${e.by_user_id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {e.by_username ?? `user ${e.by_user_id}`}
                    </a>
                  )
                : e.by_username ?? "?"
              : ""}
          </span>
        </div>
      ))}
      {query.hasNextPage && (
        <button
          style={{ marginTop: 10 }}
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          Load more
        </button>
      )}
    </>
  );
}

/** Global tops tier transitions (top 1/8/15/25/50/100). */
function GlobalList({
  filter,
  onCtx,
  ruleset,
}: {
  filter: "" | "gained" | "lost";
  onCtx: OnMapContext;
  ruleset: number;
}) {
  const query = useInfiniteQuery({
    queryKey: ["global-history", filter, ruleset],
    queryFn: ({ pageParam }) =>
      fetchGlobalHistory(pageParam, PAGE, filter || undefined, ruleset),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    refetchInterval: 60_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];

  if (query.isLoading) return <HistorySkeleton />;
  if (rows.length === 0)
    return (
      <p className="goal-note">
        No event yet. Tier changes (top 1/8/15/25/50/100) are logged as position
        checks happen (new best → immediate check, held top-100s → periodic
        re-check). The initial sweep sets the state without filling the history.
      </p>
    );

  const tierOf = (r: number | null) =>
    r == null ? null : [1, 8, 15, 25, 50, 100].find((t) => r <= t) ?? null;

  return (
    <>
      {rows.map((e, i) => {
        const gained =
          e.new_rank != null && (e.old_rank == null || e.new_rank < e.old_rank);
        const tier = tierOf(gained ? e.new_rank : e.old_rank);
        return (
          <div
            key={e.id}
            className={`fr-event fr-event-${gained ? "gained" : "lost"}${i % 2 ? " row-alt" : ""}`}
            onDoubleClick={() =>
              window.open(mapUrl(e.beatmap_id, ruleset), "_blank")
            }
            onContextMenu={(ev) => onCtx(ev, e)}
            title="Double-click: open on osu.ppy.sh · right-click: actions"
          >
            <span className="fr-event-date">{fmtDate(e.at)}</span>
            <span className={`fr-event-badge ${gained ? "gained" : "lost"}`}>
              {gained
                ? // "TOP 1", not "#1": this is the GLOBAL leaderboard history
                  `TOP ${tier}`
                : tier != null
                  ? `OUT TOP ${tier}`
                  : "LOST"}
            </span>
            <span className="fr-event-map">
              {e.artist} – {e.title}{" "}
              <span className="fr-event-diff">[{e.version}]</span>{" "}
              <span className="fr-event-sr">
                {e.star_rating != null ? `${e.star_rating.toFixed(2)}★` : ""}
              </span>
            </span>
            <span className="fr-event-by">
              {e.old_rank == null
                ? e.new_rank != null
                  ? `#${fmtNum(e.new_rank)}`
                  : "—"
                : `#${fmtNum(e.old_rank)} → ${e.new_rank != null ? `#${fmtNum(e.new_rank)}` : "—"}`}
            </span>
          </div>
        );
      })}
      {query.hasNextPage && (
        <button
          style={{ marginTop: 10 }}
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          Load more
        </button>
      )}
    </>
  );
}

export function HistoryView({ ruleset = 0 }: { ruleset?: number }) {
  const country = useCountryCode();
  const [src, setSrc] = useState<"country" | "global">("country");
  const [frFilter, setFrFilter] = useState<"" | "gained" | "lost">("");
  const [ctx, setCtx] = useState<{ x: number; y: number; row: CtxMapInfo } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const onCtx: OnMapContext = (e, row) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, row });
  };

  return (
    <div className="dashboard">
      <div className="history-cols">
        <div className="panel history-panel">
          <div className="sticky-head">
            <h3>Clears</h3>
            <ClearsHeader />
          </div>
          <ClearsList onCtx={onCtx} ruleset={ruleset} />
        </div>
        <div className="panel history-panel">
          <div className="sticky-head">
          <div className="hist-col-head">
            <div className="seg">
              <button
                className={src === "country" ? "active" : ""}
                onClick={() => setSrc("country")}
              >
                {firstPlaceLabel(country)}
              </button>
              <button
                className={src === "global" ? "active" : ""}
                onClick={() => setSrc("global")}
              >
                Global tops
              </button>
            </div>
            <div className="seg">
              <button className={frFilter === "" ? "active" : ""} onClick={() => setFrFilter("")}>
                All
              </button>
              <button className={frFilter === "gained" ? "active" : ""} onClick={() => setFrFilter("gained")}>
                Gained
              </button>
              <button className={frFilter === "lost" ? "active" : ""} onClick={() => setFrFilter("lost")}>
                Lost
              </button>
            </div>
          </div>
            <EventsHeader by={src === "country" ? "Sniped by" : "Rank"} />
          </div>
          {src === "country" ? (
            <CountryList filter={frFilter} onCtx={onCtx} ruleset={ruleset} />
          ) : (
            <GlobalList filter={frFilter} onCtx={onCtx} ruleset={ruleset} />
          )}
        </div>
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
        <MapModal beatmapId={detailId} ruleset={ruleset} onClose={() => setDetailId(null)} />
      )}
    </div>
  );
}
