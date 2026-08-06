import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchPackDetail,
  fetchPacks,
  postPacksImport,
  type PackMapRow,
  type PackRow,
} from "../api";
import { mapUrl } from "../rulesets";
import { ctxMenuStyle } from "../ctxmenu";
import { fmtDate, fmtNum } from "../format";
import { GradeBadge } from "./GradeBadge";
import { MapModal } from "./MapModal";
import { FC_LABELS } from "../types";

const TYPE_LABELS: Record<string, string> = {
  standard: "Standard",
  featured: "Featured Artist",
  tournament: "Tournament",
  loved: "Project Loved",
  chart: "Spotlights",
  theme: "Theme",
  artist: "Artist/Album",
};
// most completionist-relevant first
const TYPE_ORDER = ["standard", "loved", "artist", "theme", "featured", "tournament", "chart"];

/** untouched / started / completed / full FC */
function packState(p: PackRow): "off" | "part" | "done" | "fc" {
  if (p.total > 0 && p.fced >= p.total) return "fc";
  if (p.total > 0 && p.played >= p.total) return "done";
  if (p.played > 0) return "part";
  return "off";
}

type SortKey = "map" | "sr" | "grade" | "acc";
const GRADE_RANK: Record<string, number> = {
  XH: 7, X: 6, SH: 5, S: 4, A: 3, B: 2, C: 1, D: 0,
};

function PackModal({
  tag,
  ruleset,
  onClose,
}: {
  tag: string;
  ruleset: number;
  onClose: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["pack", tag, ruleset],
    queryFn: () => fetchPackDetail(tag, ruleset),
  });
  const [missingOnly, setMissingOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("map");
  const [sortDesc, setSortDesc] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; map: PackMapRow } | null>(null);

  const rows = useMemo(() => {
    let r = data?.maps ?? [];
    if (missingOnly) r = r.filter((m) => !m.played);
    const sorted = [...r].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "map":
          cmp = `${a.artist} ${a.title} ${a.version}`.localeCompare(
            `${b.artist} ${b.title} ${b.version}`, undefined, { sensitivity: "base" });
          break;
        case "sr": cmp = (a.star_rating ?? -1) - (b.star_rating ?? -1); break;
        case "grade":
          cmp = (a.grade ? GRADE_RANK[a.grade] ?? -1 : -1) - (b.grade ? GRADE_RANK[b.grade] ?? -1 : -1);
          break;
        case "acc": cmp = (a.accuracy ?? -1) - (b.accuracy ?? -1); break;
      }
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [data, missingOnly, sortKey, sortDesc]);

  const setSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(key === "sr" || key === "grade" || key === "acc");
    }
  };
  const arrow = (key: SortKey) => (sortKey === key ? (sortDesc ? " ▼" : " ▲") : "");

  const cleared = data?.maps.filter((m) => m.played).length ?? 0;
  const total = data?.maps.length ?? 0;
  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal pack-modal">
        <div className="adv-head">
          <h2>
            ({tag}) {data?.name ?? "…"}
          </h2>
          <button className="mm-close" onClick={onClose}>✕</button>
        </div>
        {data && (
          <>
            <div className="pack-sub">
              {data.date && <span className="dim">Date: {fmtDate(data.date)} · </span>}
              <b>{cleared} / {total}</b> cleared
              {" "}({total ? ((cleared / total) * 100).toFixed(1) : 0}%)
              {data.url && (
                <>
                  {" · "}
                  <a href={data.url} target="_blank" rel="noreferrer">
                    Download pack ↗
                  </a>
                </>
              )}
              <label className="mb-check pack-missing-toggle">
                <input
                  type="checkbox"
                  checked={missingOnly}
                  onChange={(e) => setMissingOnly(e.target.checked)}
                />
                Missing only
              </label>
            </div>
            <div className="pack-progress">
              <div
                className="pack-progress-fill"
                style={{ width: `${total ? (cleared / total) * 100 : 0}%` }}
              />
            </div>
            <div className="pack-maps">
              <table className="pack-table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => setSort("grade")}>
                      Grade{arrow("grade")}
                    </th>
                    <th>FC</th>
                    <th className="sortable th-left" onClick={() => setSort("map")}>
                      Map{arrow("map")}
                    </th>
                    <th className="sortable" onClick={() => setSort("acc")}>
                      Acc{arrow("acc")}
                    </th>
                    <th className="sortable" onClick={() => setSort("sr")}>
                      ★{arrow("sr")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr
                      key={m.id}
                      className={m.played ? "" : "pack-row-un"}
                      onDoubleClick={() => window.open(mapUrl(m.id, ruleset), "_blank")}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtx({ x: e.clientX, y: e.clientY, map: m });
                      }}
                      title="Double-click: open on osu.ppy.sh — right-click: actions"
                    >
                      <td className="pack-td-grade">
                        {m.grade ? <GradeBadge grade={m.grade} width={34} /> : <span className="dim">—</span>}
                      </td>
                      <td className="pack-td-fc">
                        {m.fc_state != null && m.fc_state <= 1 ? (
                          <b className={`fc fc-${m.fc_state}`}>{FC_LABELS[m.fc_state]}</b>
                        ) : null}
                      </td>
                      <td className="pack-td-map">
                        <span className="pack-map-title">
                          {m.artist} - {m.title}
                        </span>{" "}
                        <span className="pack-map-diff">[{m.version}]</span>
                        {m.status === 4 && <span className="pack-map-loved"> ♥</span>}
                      </td>
                      <td className="pack-td-acc">
                        {m.accuracy != null ? `${(m.accuracy * 100).toFixed(2)}%` : ""}
                      </td>
                      <td className="pack-td-sr">
                        {m.star_rating != null ? m.star_rating.toFixed(2) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
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
              {ctx.map.artist} – {ctx.map.title} [{ctx.map.version}]
            </div>
            <button
              onClick={() => {
                setDetailId(ctx.map.id);
                setCtx(null);
              }}
            >
              Map details
            </button>
            <button
              onClick={() => {
                window.open(mapUrl(ctx.map.id, ruleset), "_blank");
                setCtx(null);
              }}
            >
              Open on osu.ppy.sh
            </button>
            <button
              onClick={() => {
                window.location.href = `osu://b/${ctx.map.id}`;
                setCtx(null);
              }}
            >
              Open in osu! (osu!direct)
            </button>
          </div>
        </>
      )}
      {detailId != null && (
        <MapModal beatmapId={detailId} ruleset={ruleset} onClose={() => setDetailId(null)} />
      )}
    </>
  );
}

/**
 * Pack completion, the classic completionist way: one dot per official pack
 * (gray untouched, pink started, filled completed, gold full FC), grouped by
 * category. Definitions are an opt-in one-off import (~1h, resumable).
 */
export function PacksPanel({ ruleset = 0 }: { ruleset?: number }) {
  const { data, refetch } = useQuery({
    queryKey: ["packs", ruleset],
    queryFn: () => fetchPacks(ruleset),
    refetchInterval: 60_000,
  });
  const [openTag, setOpenTag] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  if (!data) return null;

  if (data.synced === 0)
    return (
      <div className="panel packs-panel">
        <h3>Packs</h3>
        <p className="set-note">
          Track your completion of the official beatmap packs (Standard,
          Loved, Artist, Tournament…). The pack definitions are not part of
          the normal sync: importing them costs about one request per pack
          (~1 hour for everything, resumable, new packs then arrive
          automatically).
        </p>
        <button
          className="primary"
          onClick={() => {
            void postPacksImport().then((r) => {
              setImportMsg(
                r.ok
                  ? "Import started — progress in the sync bar, the grid appears as packs come in."
                  : `Failed: ${r.error ?? "unknown"}`
              );
              setTimeout(() => void refetch(), 5000);
            });
          }}
        >
          Import pack definitions (~1h, resumable)
        </button>
        {importMsg && <p className="set-note">{importMsg}</p>}
      </div>
    );

  const cats = [...data.categories].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
  );
  return (
    <div className="panel packs-panel">
      <h3>
        Packs
        {data.pending > 0 && (
          <span className="dim"> — import in progress, {fmtNum(data.pending)} to go</span>
        )}
      </h3>
      {cats.map(({ type, packs }) => {
        const done = packs.filter((p) => packState(p) === "done" || packState(p) === "fc");
        const fc = packs.filter((p) => packState(p) === "fc");
        return (
          <div key={type} className="pack-cat">
            <div className="pack-cat-head">
              <b>{TYPE_LABELS[type] ?? type}</b>
              <span className="dim">
                {" "}Packs: {fmtNum(packs.length)} · Completed:{" "}
                {fmtNum(done.length)} ({fmtNum(fc.length)} full FC) ·{" "}
                {((done.length / packs.length) * 100).toFixed(2)}%
              </span>
            </div>
            <div className="pack-dots">
              {packs.map((p) => (
                <button
                  key={p.tag}
                  className={`pack-dot pack-${packState(p)}`}
                  title={`(${p.tag}) ${p.name}\n${p.played}/${p.total} cleared · ${p.fced} FC`}
                  onClick={() => setOpenTag(p.tag)}
                />
              ))}
            </div>
          </div>
        );
      })}
      {openTag && (
        <PackModal tag={openTag} ruleset={ruleset} onClose={() => setOpenTag(null)} />
      )}
    </div>
  );
}
