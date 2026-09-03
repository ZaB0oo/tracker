import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSyncStatus } from "../api";
import type { SyncStatus } from "../types";

type Best = SyncStatus["bests"][number];

const displayGrade = (g: string) => (g === "XH" ? "SSH" : g === "X" ? "SS" : g);
const coverUrl = (setId: number) =>
  `https://assets.ppy.sh/beatmaps/${setId}/covers/list.jpg`;

/** honors line: "country #1 · global top 12", empty when none */
const honors = (e: Best): string =>
  [e.countryFirst ? "country #1" : "", e.globalRank != null && e.globalRank <= 100 ? `global #${e.globalRank}` : ""]
    .filter(Boolean)
    .join(" · ");

const TOAST_MS = 8000;
const MAX_SHOWN = 4;

/**
 * "New best" toasts: watches the sync status best feed (shared 5 s query)
 * and reacts to entries newer than the last id seen. The first payload only
 * initialises the cursor, so a page refresh never replays old bests. Also
 * pulls the dashboard aggregates immediately so the tiles animate now
 * instead of on their next 60 s tick. Everything stays INSIDE the app
 * window: no system notification (tried, removed on request).
 */
export function BestToasts() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["sync"],
    queryFn: fetchSyncStatus,
    refetchInterval: 5000,
  });
  const lastSeen = useRef<number | null>(null);
  const [toasts, setToasts] = useState<Best[]>([]);

  useEffect(() => {
    const feed = data?.bests;
    if (!feed) return;
    const maxId = feed.reduce((m, e) => Math.max(m, e.id), 0);
    if (lastSeen.current == null) {
      lastSeen.current = maxId; // first load: arm the cursor, no replay
      return;
    }
    if (maxId <= lastSeen.current) return;
    const seen = lastSeen.current;
    lastSeen.current = maxId;
    const fresh = feed.filter((e) => e.id > seen);
    setToasts((t) => [...t, ...fresh].slice(-MAX_SHOWN));
    for (const e of fresh)
      setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== e.id)),
        TOAST_MS
      );
    // the aggregates behind the tiles refresh on a 60 s tick: pull them now
    // so the count-up and the pulse react to the best, not a minute later.
    // "auth" included: the poll just marked the profile stale, so this hit
    // kicks the background profile refetch immediately
    void qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] !== "sync",
    });
  }, [data, qc]);

  if (toasts.length === 0) return null;
  return (
    <div className="best-toast-stack">
      {toasts.map((e) => (
        <div
          key={e.id}
          className="best-toast"
          onClick={() => setToasts((t) => t.filter((x) => x.id !== e.id))}
          title="Click to dismiss"
        >
          <img src={coverUrl(e.setId)} alt="" loading="lazy" />
          <div className="best-toast-txt">
            <b>{e.firstClear ? "New clear" : "Improved best"}</b>
            <span>{e.label}</span>
            <i>
              {displayGrade(e.grade)} · {(e.accuracy * 100).toFixed(2)}%
              {e.pp != null ? ` · ${Math.round(e.pp)}pp` : ""}
              {honors(e) ? ` · ${honors(e)}` : ""}
            </i>
          </div>
        </div>
      ))}
    </div>
  );
}
