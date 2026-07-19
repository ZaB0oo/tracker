import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchClears, fetchFrHistory } from "../api";
import { firstPlaceLabel, useCountryCode } from "../country";
import { fmtDateTime } from "../format";
import { FC_LABELS } from "../types";

const PAGE = 100;

/** "YYYY-MM-DD HH:MM:SS" (UTC SQLite) or ISO -> readable local time */
const fmtDate = (at: string) => {
  const iso = at.includes("T") ? at : at.replace(" ", "T") + "Z";
  return fmtDateTime(iso);
};
const fmtInt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US");
const grade = (g: string) => (g === "X" ? "SS" : g === "XH" ? "SSH" : g);

function ClearsList() {
  const query = useInfiniteQuery({
    queryKey: ["clears"],
    queryFn: ({ pageParam }) => fetchClears(pageParam, PAGE),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    refetchInterval: 60_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];

  if (query.isLoading) return <p className="goal-note">Loading...</p>;
  if (rows.length === 0)
    return <p className="goal-note">No score in the database yet.</p>;

  return (
    <>
      <div className="hist-header">
        <span className="fr-event-date">Date</span>
        <span className="fr-event-badge">Grade</span>
        <span className="fr-event-map">Map</span>
        <span className="fc">FC</span>
        <span className="fr-event-score">Score</span>
        <span className="fr-event-acc">Acc</span>
      </div>
      {rows.map((c, i) => (
        <div
          key={c.id}
          className={`fr-event${i % 2 ? " row-alt" : ""}`}
          onDoubleClick={() =>
            window.open(`https://osu.ppy.sh/b/${c.beatmap_id}`, "_blank")
          }
          title="Double-click: open the map on osu.ppy.sh"
        >
          <span className="fr-event-date">{fmtDate(c.ended_at)}</span>
          <span className={`fr-event-badge grade grade-${grade(c.rank)}`}>
            {grade(c.rank)}
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

function FrList({ filter }: { filter: "" | "gained" | "lost" }) {
  const query = useInfiniteQuery({
    queryKey: ["fr-history", filter],
    queryFn: ({ pageParam }) =>
      fetchFrHistory(pageParam, PAGE, filter || undefined),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    refetchInterval: 60_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.rows) ?? [];

  if (query.isLoading) return <p className="goal-note">Loading...</p>;
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
      <div className="hist-header">
        <span className="fr-event-date">Date</span>
        <span className="fr-event-badge">Event</span>
        <span className="fr-event-map">Map</span>
        <span className="fr-event-by">Sniped by</span>
      </div>
      {rows.map((e, i) => (
        <div
          key={e.id}
          className={`fr-event fr-event-${e.event}${i % 2 ? " row-alt" : ""}`}
          onDoubleClick={() =>
            window.open(`https://osu.ppy.sh/b/${e.beatmap_id}`, "_blank")
          }
          title="Double-click: open the map on osu.ppy.sh"
        >
          <span
            className="fr-event-date"
            title={`Detected on ${fmtDate(e.at)}${e.score_at ? ` — score set on ${fmtDate(e.score_at)}` : ""}`}
          >
            {fmtDate(e.score_at ?? e.at)}
          </span>
          <span className={`fr-event-badge ${e.event}`}>
            {e.event === "gained" ? "🥇 GAINED" : "💀 LOST"}
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

export function HistoryView() {
  const country = useCountryCode();
  const [frFilter, setFrFilter] = useState<"" | "gained" | "lost">("");

  return (
    <div className="dashboard">
      <div className="history-cols">
        <div className="panel history-panel">
          <h3>Clears</h3>
          <ClearsList />
        </div>
        <div className="panel history-panel">
          <div className="hist-col-head">
            <h3>{firstPlaceLabel(country)} history</h3>
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
          <FrList filter={frFilter} />
        </div>
      </div>
    </div>
  );
}
