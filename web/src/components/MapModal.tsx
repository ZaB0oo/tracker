import { useQuery } from "@tanstack/react-query";
import { fetchMapDetail } from "../api";
import { firstPlaceLabel, useCountryCode } from "../country";
import { GradeBadge } from "./GradeBadge";
import { MedalIcon } from "./Icons";
import { fmtDate, fmtDateTime } from "../format";
import { FC_LABELS, STATUS_LABELS } from "../types";

const fmt = (n: number) => n.toLocaleString("en-US");
const fmtDT = (iso: string) => fmtDateTime(iso);
const mmss = (s: number | null) =>
  s == null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const displayGrade = (r: string) => (r === "XH" ? "SSH" : r === "X" ? "SS" : r);

function modsText(raw: string): string {
  try {
    const m = JSON.parse(raw) as { acronym: string }[];
    return m.length ? m.map((x) => x.acronym).join(" ") : "nomod";
  } catch {
    return "—";
  }
}

/** Detailed map view: stats, all my scores, country #1 history. */
export function MapModal({
  beatmapId,
  onClose,
}: {
  beatmapId: number;
  onClose: () => void;
}) {
  const country = useCountryCode();
  const { data } = useQuery({
    queryKey: ["map", beatmapId],
    queryFn: () => fetchMapDetail(beatmapId),
  });

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="map-modal">
        {!data ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="map-modal-head">
              <h2>
                {data.map.artist} – {data.map.title}{" "}
                <span className="mm-diff">[{data.map.version}]</span>
              </h2>
              <button className="mm-close" onClick={onClose}>
                ✕
              </button>
            </div>
            <div className="mm-sub">
              by {data.map.creator} ·{" "}
              {STATUS_LABELS[data.map.status] ?? data.map.status}
              {data.map.ranked_date
                ? ` · rank ${fmtDate(data.map.ranked_date)}`
                : ""}
              {data.map.dmca ? " · ⛔ DMCA" : ""} ·{" "}
              <a
                href={`https://osu.ppy.sh/b/${data.map.id}`}
                target="_blank"
                rel="noreferrer"
              >
                osu.ppy.sh
              </a>{" "}
              · <a href={`osu://b/${data.map.id}`}>osu!direct</a>
            </div>
            <div className="mm-stats">
              {(
                [
                  ["★", data.map.star_rating?.toFixed(2)],
                  ["AR", data.map.ar],
                  ["OD", data.map.od],
                  ["CS", data.map.cs],
                  ["HP", data.map.hp],
                  ["BPM", data.map.bpm],
                  ["Length", mmss(data.map.total_length)],
                  ["Max combo", data.map.max_combo],
                  [
                    "Objects",
                    (data.map.count_circles ?? 0) +
                      (data.map.count_sliders ?? 0) +
                      (data.map.count_spinners ?? 0),
                  ],
                ] as [string, string | number | null | undefined][]
              ).map(([k, v]) => (
                <span key={k} className="mm-stat">
                  <b>{k}</b> {v ?? "—"}
                </span>
              ))}
              {data.user?.country_first ? (
                <span className="mm-stat mm-gold">
                  <MedalIcon width={13} /> {firstPlaceLabel(country)}
                </span>
              ) : null}
              {data.user?.any_fc ? (
                <span className="mm-stat mm-green">FC ✓</span>
              ) : null}
            </div>

            <h3>My scores ({data.scores.length})</h3>
            {data.scores.length === 0 && (
              <p className="goal-note">No score recorded on this map.</p>
            )}
            {data.scores.map((s) => (
              <div key={s.id} className="mm-score-row">
                <span className="mm-date">{fmtDT(s.ended_at)}</span>
                <span className="mm-grade">
                  <GradeBadge grade={s.rank} width={34} title={displayGrade(s.rank)} />
                </span>
                <span className="mm-mods">{modsText(s.mods)}</span>
                <span className="mm-acc">{(s.accuracy * 100).toFixed(2)}%</span>
                <span className="mm-score">{fmt(s.total_score)} std</span>
                <span className="mm-score">
                  {s.classic_total_score != null
                    ? `${fmt(s.classic_total_score)} classic`
                    : ""}
                </span>
                <span className="mm-combo">{fmt(s.max_combo)}x</span>
                <span className={`mm-fc fc fc-${s.fc_state}`}>
                  {FC_LABELS[s.fc_state]}
                </span>
                <span className="mm-pp">
                  {s.pp != null ? `${Math.round(s.pp)}pp` : ""}
                </span>
              </div>
            ))}

            {data.countryEvents.length > 0 && (
              <>
                <h3>{firstPlaceLabel(country)} history</h3>
                {data.countryEvents.map((e, i) => (
                  <div key={i} className="mm-score-row">
                    <span className="mm-date">{fmtDT(e.score_at ?? e.at)}</span>
                    <span className={e.event === "gained" ? "mm-green" : "mm-red"}>
                      {e.event === "gained" ? "#1 gained" : "#1 lost"}
                    </span>
                    <span>{e.by_username ? `by ${e.by_username}` : ""}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
