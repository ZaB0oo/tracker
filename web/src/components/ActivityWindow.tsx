import { useQuery } from "@tanstack/react-query";
import { fetchSyncStatus } from "../api";
import { fmtTime } from "../format";

/**
 * Dedicated window for the activity feed (opened via the syncbar's ⧉ button,
 * URL ?activity=1). Same data as the mini-feed, at full height.
 */
export function ActivityWindow() {
  const { data: s } = useQuery({
    queryKey: ["sync"],
    queryFn: fetchSyncStatus,
    refetchInterval: 2000,
  });

  const entries = s?.activity ? [...s.activity].reverse() : [];

  return (
    <div className="activity-window">
      <header className="activity-header">
        <h1>
          Activity <span className="accent">real-time</span>
        </h1>
        <span className="activity-sub">
          {s?.busy?.length
            ? `running: ${s.busy.join(" + ")}`
            : "no background task"}
          {" — "}
          {entries.length} entry(ies), refreshed every 2 s
        </span>
      </header>
      <div className="activity-list">
        {entries.length === 0 && (
          <div className="feed-row feed-empty">
            Nothing yet.
          </div>
        )}
        {entries.map((a, i) => (
          <div key={`${a.at}-${i}`} className="feed-row activity-row">
            <span className="feed-time">
              {fmtTime(a.at)}
            </span>
            <span className="feed-src">{a.source}</span>
            <span className="feed-text" title={a.text}>
              {a.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
