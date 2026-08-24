import { memo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchRecords, type DashScope, type RecordEntry } from "../api";
import { ctxMenuStyle } from "../ctxmenu";
import { fmtDate, fmtNum } from "../format";
import { mapUrl } from "../rulesets";
import type { PoolMode } from "../types";
import { MapModal } from "./MapModal";

const cover = (setId: number) =>
  `https://assets.ppy.sh/beatmaps/${setId}/covers/card.jpg`;

/**
 * All-time record plays as cards inside the hero, each on its map's cover.
 * The star records carry the rating of the mods played. Right-click opens the
 * same context menu as the table rows; dimmed under the time machine
 * (records are not historised).
 */
export const HeroRecords = memo(function HeroRecords({
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
  const { data } = useQuery({
    queryKey: ["records", ruleset, pool, keys, scope],
    queryFn: () => fetchRecords(ruleset, pool, keys, scope),
    refetchInterval: 60_000,
  });
  const [modalId, setModalId] = useState<number | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; rec: RecordEntry } | null>(null);
  if (!data) return null;
  // "6.71★ DT 1.1x": the mods played, with the exact rate when customised
  const star = (r: RecordEntry) =>
    `${(r.value ?? 0).toFixed(2)}★${r.mods?.length ? ` ${r.mods.join(" ")}` : ""}${
      r.rate != null && r.rate !== 1 ? ` ${r.rate}x` : ""
    }`;
  // First clear IS a date: its value line already says it, no date footer
  const cards: {
    label: string;
    rec: RecordEntry | null;
    text: (r: RecordEntry) => string;
    hideDate?: boolean;
  }[] = [
    { label: "Top score play", rec: data.topClassic, text: (r) => fmtNum(r.value ?? 0) },
    { label: "Top performance play", rec: data.topPp, text: (r) => `${(r.value ?? 0).toFixed(2)}pp` },
    { label: "Top stars FC play", rec: data.bestFcSr, text: star },
    { label: "Top stars SS play", rec: data.bestSsSr, text: star },
    { label: "Peak combo play", rec: data.peakCombo, text: (r) => `${fmtNum(r.value ?? 0)}x` },
    { label: "First clear", rec: data.oldest, text: (r) => fmtDate(r.at), hideDate: true },
  ];
  const shown = cards.filter((c) => c.rec != null);
  if (shown.length === 0) return null;
  return (
    <div className={`hero-records${dimmed ? " tm-dim" : ""}`}>
      {shown.map((c) => (
        <button
          key={c.label}
          className="rec-card"
          // same conventions as the table rows: right-click for the context
          // menu, double-click for the official page
          onContextMenu={(e) => {
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, rec: c.rec! });
          }}
          onDoubleClick={() => window.open(mapUrl(c.rec!.mapId, ruleset), "_blank")}
          title={`${c.rec!.artist} – ${c.rec!.title} [${c.rec!.diff}]`}
          style={{ backgroundImage: `url(${cover(c.rec!.setId)})` }}
        >
          <span className="rec-card-label">{c.label}</span>
          <b className="rec-card-value">{c.text(c.rec!)}</b>
          <span className="rec-card-map">
            {c.rec!.title} [{c.rec!.diff}]
          </span>
          {!c.hideDate && <span className="rec-card-date">{fmtDate(c.rec!.at)}</span>}
        </button>
      ))}
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
              {ctx.rec.artist} – {ctx.rec.title} [{ctx.rec.diff}]
            </div>
            <button
              onClick={() => {
                setModalId(ctx.rec.mapId);
                setCtx(null);
              }}
            >
              Map details
            </button>
            <button
              onClick={() => {
                window.open(mapUrl(ctx.rec.mapId, ruleset), "_blank");
                setCtx(null);
              }}
            >
              Open on osu.ppy.sh
            </button>
            <button
              onClick={() => {
                window.location.href = `osu://b/${ctx.rec.mapId}`;
                setCtx(null);
              }}
            >
              Open in osu! (osu!direct)
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(String(ctx.rec.mapId));
                setCtx(null);
              }}
            >
              Copy beatmap id
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(
                  `${ctx.rec.artist} - ${ctx.rec.title} [${ctx.rec.diff}]`
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
});
