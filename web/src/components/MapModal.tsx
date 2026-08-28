import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { mapUrl, rulesetStatFields } from "../rulesets";
import { fetchMapDetail } from "../api";
import { firstPlaceLabel, useCountryCode } from "../country";
import { GradeBadge } from "./GradeBadge";
import { MedalIcon } from "./Icons";
import { displayGrade, effPp, fmtDate, fmtDateTime, fmtNum, ppText } from "../format";
import { FC_LABELS, STATUS_LABELS, type MapDetail } from "../types";
import { useEscape } from "../useEscape";
import { ScoreCard } from "./ScoreCard";

const mmss = (s: number | null) =>
  s == null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function modsText(raw: string): string {
  try {
    const m = JSON.parse(raw) as { acronym: string }[];
    return m.length ? m.map((x) => x.acronym).join(" ") : "nomod";
  } catch {
    return "—";
  }
}

/** Detailed map view: stats, all my scores, country #1 history. */
/** Sortable columns of the score table. `key` reads the sort value of a row;
 * null sorts last whatever the direction, like the Maps table. */
type ScoreRow = MapDetail["scores"][number];
const SCORE_COLS: {
  id: string;
  label: string;
  right?: boolean;
  key: (s: ScoreRow) => number | string | null;
}[] = [
  { id: "date", label: "Date", key: (s) => s.ended_at },
  { id: "grade", label: "Grade", key: (s) => GRADE_RANK[s.rank] ?? -1 },
  { id: "mods", label: "Mods", key: (s) => modsText(s.mods) },
  { id: "rate", label: "Rate", right: true, key: (s) => s.rate },
  { id: "multi", label: "Multi", right: true, key: (s) => s.mod_multiplier },
  { id: "acc", label: "Acc", right: true, key: (s) => s.accuracy },
  { id: "combo", label: "Combo", right: true, key: (s) => s.max_combo },
  { id: "fc", label: "FC", key: (s) => -s.fc_state },
  { id: "classic", label: "Classic", right: true, key: (s) => s.classic_total_score },
  { id: "std", label: "Standardised", right: true, key: (s) => s.total_score },
  { id: "pp", label: "pp", right: true, key: (s) => effPp(s) },
];
const GRADE_RANK: Record<string, number> = {
  XH: 7, X: 6, SH: 5, S: 4, A: 3, B: 2, C: 1, D: 0,
};

export function MapModal({
  beatmapId,
  onClose,
  ruleset = 0,
}: {
  beatmapId: number;
  onClose: () => void;
  ruleset?: number;
}) {
  useEscape(onClose); // Esc closes the top-most modal
  const country = useCountryCode();
  const stats = rulesetStatFields(ruleset);
  const { data } = useQuery({
    queryKey: ["map", beatmapId, ruleset],
    queryFn: () => fetchMapDetail(beatmapId, ruleset),
  });
  // Classic descending by default: the badges above (grade, FC, #1, global)
  // all describe the BEST score, so the table has to open on it rather than
  // on the most recent play.
  const [sort, setSort] = useState({ id: "classic", desc: true });
  const [openScore, setOpenScore] = useState<ScoreRow | null>(null);
  const bestId = data?.user?.best_lazer_score_id ?? null;
  const sortedScores = useMemo(() => {
    const col = SCORE_COLS.find((c) => c.id === sort.id) ?? SCORE_COLS[0];
    return [...(data?.scores ?? [])].sort((a, b) => {
      const x = col.key(a);
      const y = col.key(b);
      if (x == null) return y == null ? 0 : 1; // nulls last, both directions
      if (y == null) return -1;
      const cmp = typeof x === "string" ? x.localeCompare(String(y)) : Number(x) - Number(y);
      return sort.desc ? -cmp : cmp;
    });
  }, [data?.scores, sort]);

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="map-modal">
        {!data ? (
          <p>Loading…</p>
        ) : (
          <>
            {/* the set's cover art behind the title block, darkened like the
                hero record cards; a missing cover just leaves the plain bg */}
            <div
              className="mm-banner"
              style={{
                backgroundImage: `url(https://assets.ppy.sh/beatmaps/${data.map.beatmapset_id}/covers/cover.jpg)`,
              }}
            >
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
                href={mapUrl(data.map.id, ruleset)}
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
                  ...(stats.ar
                    ? ([["AR", data.map.ar?.toFixed(2)]] as [string, string | null][])
                    : []),
                  ["OD", data.map.od?.toFixed(2)],
                  ...(stats.cs
                    ? ([[
                        stats.csLabel,
                        // mania key count stays an integer
                        stats.csLabel === "Keys"
                          ? data.map.cs
                          : data.map.cs?.toFixed(2),
                      ]] as [string, string | number | null][])
                    : []),
                  ["HP", data.map.hp?.toFixed(2)],
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
              {data.user?.global_rank != null && data.user.global_rank <= 100 ? (
                <span className="mm-stat mm-gold">Global #{data.user.global_rank}</span>
              ) : null}
              {data.user?.best_fc ? (
                <span className="mm-stat mm-green" title="My best score on this map is an FC">
                  FC ✓
                </span>
              ) : null}
            </div>
            </div>

            <h3>My scores ({data.scores.length})</h3>
            {data.scores.length === 0 ? (
              <p className="goal-note">No score recorded on this map.</p>
            ) : (
              <table className="mm-scores">
                <thead>
                  <tr>
                    {SCORE_COLS.map((c) => (
                      <th
                        key={c.id}
                        className={`${c.right ? "num" : ""} ${sort.id === c.id ? "on" : ""}`}
                        title="Click to sort"
                        onClick={() =>
                          setSort((p) =>
                            p.id === c.id ? { id: c.id, desc: !p.desc } : { id: c.id, desc: true }
                          )
                        }
                      >
                        {c.label}
                        {sort.id === c.id ? (sort.desc ? " ▼" : " ▲") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedScores.map((s) => (
                    <tr
                      key={s.id}
                      className={`mm-row${s.id === bestId ? " mm-best" : ""}`}
                      title={
                        s.id === bestId
                          ? "The score that counts on the leaderboard: click for details"
                          : "Click for details"
                      }
                      onClick={() => setOpenScore(s)}
                    >
                      <td>{fmtDateTime(s.ended_at)}</td>
                      <td>
                        <GradeBadge grade={s.rank} width={34} title={displayGrade(s.rank)} />
                      </td>
                      <td>{modsText(s.mods)}</td>
                      <td className="num">{s.rate != null && s.rate !== 1 ? `${s.rate}x` : ""}</td>
                      <td className="num">
                        {s.mod_multiplier != null ? `×${s.mod_multiplier.toFixed(2)}` : ""}
                      </td>
                      <td className="num">{(s.accuracy * 100).toFixed(2)}%</td>
                      <td className="num">
                        {fmtNum(s.max_combo)}x
                        {data.map.max_combo != null && data.map.max_combo > 0 && (
                          <i className="sess-sc-max">/{fmtNum(data.map.max_combo)}x</i>
                        )}
                      </td>
                      <td className={`fc fc-${s.fc_state}`}>{FC_LABELS[s.fc_state]}</td>
                      <td className="num">
                        {s.classic_total_score != null ? fmtNum(s.classic_total_score) : ""}
                      </td>
                      <td className="num">{fmtNum(s.total_score)}</td>
                      <td
                        className="num"
                        title={s.pp == null && effPp(s) != null ? "Estimated locally (no official pp)" : undefined}
                      >
                        {ppText(s)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {openScore && (
              <ScoreCard
                score={openScore}
                map={data.map}
                ruleset={ruleset}
                isBest={openScore.id === bestId}
                onClose={() => setOpenScore(null)}
              />
            )}

            {data.countryEvents.length > 0 && (
              <>
                <h3>{firstPlaceLabel(country)} history</h3>
                {data.countryEvents.map((e, i) => (
                  <div key={i} className="mm-score-row">
                    <span className="mm-date">{fmtDateTime(e.score_at ?? e.at)}</span>
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
