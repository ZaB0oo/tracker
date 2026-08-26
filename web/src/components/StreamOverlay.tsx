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
import { GRADE_ORDER, type PoolMode } from "../types";

// Custom metric ids from the ?metrics= query param (chosen in the configurator)
const METRIC_IDS = (new URLSearchParams(window.location.search).get("metrics") ?? "")
  .split(",")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);

const delta = (cur: number, base: number) => cur - base;

// ruleset, map pool and mania key count scoped by the browser-source URL
// (?overlay=1&ruleset=3&pool=specific&keys=7 = mania 7K specifics only)
const OVERLAY_PARAMS = new URLSearchParams(window.location.search);
const OVERLAY_RULESET = Number(OVERLAY_PARAMS.get("ruleset")) || 0;
const OVERLAY_POOL: PoolMode =
  OVERLAY_PARAMS.get("pool") === "specific"
    ? "specific"
    : OVERLAY_PARAMS.get("pool") === "converts"
      ? "converts"
      : "all";
const OVERLAY_KEYS = (OVERLAY_PARAMS.get("keys") ?? "")
  .split(",")
  .filter((k) => ["4", "7", "other"].includes(k));

/**
 * Stream overlay (OBS browser source, /?overlay=1): transparent background,
 * session stats (since the source was loaded) + total stats.
 */
export function StreamOverlay() {
  const { data } = useQuery({
    queryKey: ["overlay"],
    queryFn: () => fetchOverlayStats(OVERLAY_RULESET, OVERLAY_POOL, OVERLAY_KEYS),
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

  // Card background from the URL (?bg=rrggbbaa), set in the overlay config.
  // The PAGE stays transparent whatever it says: that is what OBS composites.
  const card = (() => {
    const raw = new URLSearchParams(window.location.search).get("bg");
    if (!raw || !/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw)) return {};
    const n = parseInt(raw.slice(0, 6), 16);
    const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const alpha = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
    // Relative luminance (WCAG): dark text on a light panel, light text on a
    // dark one. Below half opacity the real backdrop is the game, which we
    // cannot measure — light text stays the safer bet there.
    const lin = rgb
      .map((v) => v / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const luminance = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return { style: { background: `#${raw}` }, light: alpha >= 0.5 && luminance > 0.45 };
  })();

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

  // last play OF THIS MODE, straight from the overlay payload: the activity
  // feed is not mode-tagged, so it showed osu! plays on a mania overlay
  const lastPlay = data.lastPlay;

  // Rows to hide, from the ?hide= query param (OBS browser sources can't share
  // localStorage, so overlay content is configured through the URL).
  const hide = new Set(
    (new URLSearchParams(window.location.search).get("hide") ?? "")
      .split(",")
      .filter(Boolean)
  );

  /**
   * Session delta of a counter. Negative values are real and were hidden
   * before: a grade tier LOSES one when a S becomes a SS, a countdown metric
   * goes DOWN as you fix maps, and a #1 can be sniped mid-stream. `goodDown`
   * flips the coloring for counters where going down is the progress.
   */
  const gainTag = (gain: number, fmt = fmtNum, goodDown = false) => {
    if (gain === 0) return null;
    const good = goodDown ? gain < 0 : gain > 0;
    return (
      <span className={good ? "ov-gain" : "ov-loss"}>
        {" "}
        {gain > 0 ? "+" : "-"}
        {fmt(Math.abs(gain))}
      </span>
    );
  };
  /** total + signed session delta, one counter per stat */
  const stat = (label: string, total: string, gain: number) => (
    <span>
      {label} <b>{total}</b>
      {gainTag(gain)}
    </span>
  );
  const TIERS = [
    // "Top 1", not "#1": on stream the bare #1 read like the country #1
    ["Top 1", "top1"],
    ["Top 8", "top8"],
    ["Top 15", "top15"],
    ["Top 25", "top25"],
    ["Top 50", "top50"],
    ["Top 100", "top100"],
  ] as const;
  const anyGlobal = Object.values(data.globalTops).some((v) => v > 0);

  return (
    <div className="overlay-root">
      <div className={`ov-card${card.light ? " ov-light" : ""}`} style={card.style}>
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
              {gainTag(delta(data.clears, b.clears))}
            </span>
          )}
          {!hide.has("fc") && stat("FC", fmtNum(data.fc), delta(data.fc, b.fc))}
          {!hide.has("ranked") && (
            <span>
              Score <b>{fmtNum(data.rankedClassic)}</b>
              {gainTag(rankedGain)}
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
                    {gainTag(gain)}
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
                      {gainTag(gain)}
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
              const f = m.kind === "ranked_score" || m.kind === "std_score" ? fmtCompact : fmtNum;
              return (
                <span key={m.id}>
                  {m.name} <b>{f(m.count)}</b>
                  {m.total > 0 && (
                    <span className="ov-dim">
                      {" "}/ {f(m.total)} ({((m.count / m.total) * 100).toFixed(1)}%)
                    </span>
                  )}
                  {gainTag(gain, f, m.descending === true)}
                </span>
              );
            })}
          </div>
        )}
        {!hide.has("last") && lastPlay && (
          <div
            className="ov-row ov-last"
            title={`${lastPlay.artist} - ${lastPlay.title} [${lastPlay.version}] · ${lastPlay.rank} · ${lastPlay.at.slice(0, 16).replace("T", " ")}`}
          >
            <span className="ov-tag">LAST PLAYED</span>
            <span className="ov-lastmap">
              {lastPlay.artist} - {lastPlay.title} [{lastPlay.version}]
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
