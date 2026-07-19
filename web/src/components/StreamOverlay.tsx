import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOverlayStats, fetchSyncStatus, type OverlayStats } from "../api";
import { firstPlaceLabel, useCountryCode } from "../country";

// OBS overlay => English text, numbers in en-US format.
const fmt = (n: number) => n.toLocaleString("en-US");
const fmtB = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`
      : fmt(n);

const delta = (cur: number, base: number) => cur - base;
const plus = (n: number) => (n > 0 ? `+${fmt(n)}` : "0");

/**
 * Stream overlay (OBS browser source, /?overlay=1): transparent background,
 * session stats (since the source was loaded) + total stats.
 */
export function StreamOverlay() {
  const { data } = useQuery({
    queryKey: ["overlay"],
    queryFn: fetchOverlayStats,
    refetchInterval: 5000,
  });
  const { data: sync } = useQuery({
    queryKey: ["sync"],
    queryFn: fetchSyncStatus,
    refetchInterval: 5000,
  });
  const country = useCountryCode();
  const baseline = useRef<OverlayStats | null>(null);
  const startedAt = useRef(Date.now());
  const [, tick] = useState(0);

  // transparent background for OBS
  useEffect(() => {
    document.body.classList.add("overlay-body");
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (data && !baseline.current) baseline.current = data;
  if (!data || !baseline.current) return null;
  const b = baseline.current;

  const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const timer = `${pad(Math.floor(elapsed / 3600))}:${pad(
    Math.floor((elapsed % 3600) / 60)
  )}:${pad(elapsed % 60)}`;

  const completion = data.totalMaps > 0 ? (data.clears / data.totalMaps) * 100 : 0;
  const nextS = (Math.floor(data.s / 1000) + 1) * 1000;
  const rankedGain = delta(data.rankedClassic, b.rankedClassic);

  // last new score seen by the poll (activity feed)
  const lastPlay = sync?.activity
    ?.filter((a) => a.source === "poll")
    .slice(-1)[0];

  // Rows to hide, from the ?hide= query param (OBS browser sources can't share
  // localStorage, so overlay content is configured through the URL).
  const hide = new Set(
    (new URLSearchParams(window.location.search).get("hide") ?? "")
      .split(",")
      .filter(Boolean)
  );

  return (
    <div className="overlay-root">
      <div className="ov-card">
        {!hide.has("session") && (
          <div className="ov-row ov-session">
            <span className="ov-tag">SESSION</span>
            <span className="ov-timer">{timer}</span>
            <span>Clears <b>{plus(delta(data.clears, b.clears))}</b></span>
            <span>S <b>{plus(delta(data.s, b.s))}</b></span>
            <span>FC <b>{plus(delta(data.fc, b.fc))}</b></span>
            <span>{firstPlaceLabel(country)} <b>{plus(delta(data.fr, b.fr))}</b></span>
            <span>
              Score <b>{rankedGain > 0 ? `+${fmt(rankedGain)}` : "0"}</b>
            </span>
          </div>
        )}
        {!hide.has("total") && (
          <div className="ov-row">
            <span className="ov-tag">TOTAL</span>
            <span>
              Clears <b>{fmt(data.clears)}</b>
              <span className="ov-dim"> / {fmt(data.totalMaps)} ({completion.toFixed(2)}%)</span>
            </span>
            <span>S <b>{fmt(data.s)}</b></span>
            <span>FC <b>{fmt(data.fc)}</b></span>
            <span>{firstPlaceLabel(country)} <b>{fmt(data.fr)}</b></span>
          </div>
        )}
        {!hide.has("ranked") && (
          <div className="ov-row">
            <span className="ov-tag">RANKED SCORE</span>
            <span>Classic <b>{fmt(data.rankedClassic)}</b></span>
          </div>
        )}
        {!hide.has("last") && lastPlay && (
          <div className="ov-row ov-last" title={lastPlay.text}>
            <span className="ov-tag">LAST PLAYED</span>
            <span className="ov-lastmap">{lastPlay.text.split(" — ")[0]}</span>
          </div>
        )}
      </div>
    </div>
  );
}
