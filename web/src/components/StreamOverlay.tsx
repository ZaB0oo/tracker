import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchOverlayMetrics,
  fetchOverlayStats,
  fetchSyncStatus,
  type OverlayStats,
} from "../api";
import { firstPlaceLabel, useCountryCode } from "../country";
import { GradeBadge } from "./GradeBadge";
// OBS overlay => English text, numbers in en-US format.
import { fmtCompact, fmtNum } from "../format";
import { GRADE_ORDER } from "../types";

// Custom metric ids from the ?metrics= query param (chosen in the configurator)
const METRIC_IDS = (new URLSearchParams(window.location.search).get("metrics") ?? "")
  .split(",")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);

const delta = (cur: number, base: number) => cur - base;

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
  const { data: metrics } = useQuery({
    queryKey: ["overlay-metrics"],
    queryFn: () => fetchOverlayMetrics(METRIC_IDS),
    refetchInterval: 5000,
    enabled: METRIC_IDS.length > 0,
  });
  const country = useCountryCode();
  const metricBaseline = useRef<Map<number, number> | null>(null);
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
  if (metrics && !metricBaseline.current)
    metricBaseline.current = new Map(metrics.metrics.map((m) => [m.id, m.count]));
  if (!data || !baseline.current) return null;
  const b = baseline.current;

  const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const timer = `${pad(Math.floor(elapsed / 3600))}:${pad(
    Math.floor((elapsed % 3600) / 60)
  )}:${pad(elapsed % 60)}`;

  const completion = data.totalMaps > 0 ? (data.clears / data.totalMaps) * 100 : 0;
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

  /** total + green session gain, one counter per stat */
  const stat = (label: string, total: string, gain: number) => (
    <span>
      {label} <b>{total}</b>
      {gain > 0 && <span className="ov-gain"> +{fmtNum(gain)}</span>}
    </span>
  );
  const TIERS = [
    ["#1", "top1"],
    ["Top 8", "top8"],
    ["Top 15", "top15"],
    ["Top 25", "top25"],
    ["Top 50", "top50"],
    ["Top 100", "top100"],
  ] as const;
  const anyGlobal = Object.values(data.globalTops).some((v) => v > 0);

  return (
    <div className="overlay-root">
      <div className="ov-card">
        {!hide.has("timer") && (
          <div className="ov-row ov-session">
            <span className="ov-tag">SESSION</span>
            <span className="ov-timer">{timer}</span>
          </div>
        )}
        <div className="ov-row">
          {!hide.has("clears") && (
            <span>
              Clears <b>{fmtNum(data.clears)}</b>
              <span className="ov-dim"> / {fmtNum(data.totalMaps)} ({completion.toFixed(2)}%)</span>
              {delta(data.clears, b.clears) > 0 && (
                <span className="ov-gain"> +{fmtNum(delta(data.clears, b.clears))}</span>
              )}
            </span>
          )}
          {!hide.has("fc") && stat("FC", fmtNum(data.fc), delta(data.fc, b.fc))}
          {!hide.has("ranked") && (
            <span>
              Score <b>{fmtNum(data.rankedClassic)}</b>
              {rankedGain > 0 && <span className="ov-gain"> +{fmtNum(rankedGain)}</span>}
            </span>
          )}
        </div>
        {!hide.has("grades") && (
          <div className="ov-grades">
            {GRADE_ORDER.map((k) => {
              const gain = delta(data.grades[k] ?? 0, b.grades[k] ?? 0);
              return (
                !hide.has(`grades.${k.toLowerCase()}`) && (
                  <span key={k} className="ov-grade-cell">
                    <GradeBadge grade={k} width={28} />
                    <b>{fmtNum(data.grades[k] ?? 0)}</b>
                    {gain > 0 && <span className="ov-gain">+{fmtNum(gain)}</span>}
                  </span>
                )
              );
            })}
          </div>
        )}
        {(!hide.has("country") || (!hide.has("global") && anyGlobal)) && (
          <div className="ov-section">
            <div className="ov-row">
              <span className="ov-tag">GLOBAL / {country ?? "COUNTRY"}</span>
              {!hide.has("country") &&
                stat(firstPlaceLabel(country), fmtNum(data.country), delta(data.country, b.country))}
            </div>
            {!hide.has("global") && anyGlobal && (
              <div className="ov-tiers">
                {TIERS.map(([label, key]) => {
                  const gain = delta(
                    data.globalTops[key],
                    b.globalTops?.[key] ?? data.globalTops[key]
                  );
                  return (
                    <span key={key} className="ov-tier-cell">
                      <span className="ov-tier">{label}</span>{" "}
                      <b>{fmtNum(data.globalTops[key])}</b>
                      {gain > 0 && <span className="ov-gain"> +{fmtNum(gain)}</span>}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {metrics && metrics.metrics.length > 0 && (
          <div className="ov-row ov-section">
            <span className="ov-tag">METRICS</span>
            {metrics.metrics.map((m) => {
              const base = metricBaseline.current?.get(m.id) ?? m.count;
              const gain = m.count - base;
              const f = m.kind === "ranked_score" ? fmtCompact : fmtNum;
              return (
                <span key={m.id}>
                  {m.name} <b>{f(m.count)}</b>
                  {m.total > 0 && (
                    <span className="ov-dim">
                      {" "}/ {f(m.total)} ({((m.count / m.total) * 100).toFixed(1)}%)
                    </span>
                  )}
                  {gain > 0 && <span className="ov-gain"> +{f(gain)}</span>}
                </span>
              );
            })}
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
