import { memo, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchPackDetail,
  fetchPacks,
  postPacksImport,
  type DashScope,
  type PackMapRow,
  type PackRow,
} from "../api";
import type { PoolMode } from "../types";
import { mapUrl } from "../rulesets";
import { ctxMenuStyle } from "../ctxmenu";
import { fmtDate, fmtNum } from "../format";
import { GradeBadge } from "./GradeBadge";
import { MapModal } from "./MapModal";
import { FC_LABELS } from "../types";
import { useEscape } from "../useEscape";
import { useTipPlacement } from "../useTipPlacement";

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

/** suffix of the tooltip's last line — nothing for a pack barely started */
const STATE_LABELS: Record<ReturnType<typeof packState>, string> = {
  fc: " · full FC",
  done: " · completed",
  part: "",
  off: " · untouched",
};
const pct = (v: number, total: number) =>
  total > 0 ? `${((v / total) * 100).toFixed(1)}%` : "—";

type SortKey = "map" | "sr" | "grade" | "acc" | "date";
const GRADE_RANK: Record<string, number> = {
  XH: 7, X: 6, SH: 5, S: 4, A: 3, B: 2, C: 1, D: 0,
};

function PackModal({
  tag,
  ruleset,
  at,
  pool,
  keys,
  scope,
  onViewPack,
  onClose,
}: {
  tag: string;
  ruleset: number;
  at?: string | null;
  pool: PoolMode;
  keys: string[];
  scope: DashScope;
  onViewPack?: (tag: string) => void; // scope injected by the dashboard
  onClose: () => void;
}) {
  useEscape(onClose); // Esc closes the top-most modal
  const { data } = useQuery({
    queryKey: ["pack", tag, ruleset, at ?? null, pool, keys, scope],
    queryFn: () => fetchPackDetail(tag, ruleset, at, pool, keys, scope),
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
        case "date":
          cmp = (a.ranked_date ?? "").localeCompare(b.ranked_date ?? "");
          break;
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
      setSortDesc(key === "sr" || key === "grade" || key === "acc" || key === "date");
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
              {data.at && <span className="pack-asof">as of {fmtDate(data.at)} · </span>}
              {data.date && <span className="dim">Date: {fmtDate(data.date)} · </span>}
              <b>{cleared} / {total}</b> cleared
              {" "}({total ? ((cleared / total) * 100).toFixed(1) : 0}%)
              {data.url && (
                <a
                  className="pack-action"
                  href={data.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download ↗
                </a>
              )}
              {onViewPack && (
                <button
                  className="pack-action"
                  onClick={() => {
                    onViewPack(tag);
                    onClose();
                  }}
                  title={`Open the Maps tab filtered on this pack (search: pack=${tag})`}
                >
                  View in Maps
                </button>
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
                    <th className="sortable" onClick={() => setSort("date")}>
                      Ranked{arrow("date")}
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
                      title="Double-click: open on osu.ppy.sh · right-click: actions"
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
                      <td className="pack-td-date">
                        {m.ranked_date ? fmtDate(m.ranked_date) : "—"}
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
 * `at` (time machine day): the dots replay the state as of that date.
 */
export const PacksPanel = memo(function PacksPanel({
  ruleset = 0,
  at = null,
  pool = "all",
  keys = [],
  scope = "all",
  onViewPack,
}: {
  ruleset?: number;
  at?: string | null;
  /** same map pool / keys / status scope as the rest of the dashboard */
  pool?: PoolMode;
  keys?: string[];
  scope?: DashScope;
  onViewPack?: (tag: string) => void;
}) {
  // The time-machine slider changes `at` on every tick and the ?at= query is
  // heavier than the live one: debounce it instead of firing per day dragged.
  const [atDeb, setAtDeb] = useState<string | null>(at);
  useEffect(() => {
    if (at === atDeb) return;
    const t = setTimeout(() => setAtDeb(at), 250);
    return () => clearTimeout(t);
  }, [at, atDeb]);
  const { data, refetch } = useQuery({
    queryKey: ["packs", ruleset, atDeb, pool, keys, scope],
    queryFn: () => fetchPacks(ruleset, atDeb, pool, keys, scope),
    refetchInterval: atDeb ? false : 60_000,
    placeholderData: (prev) => prev, // keep the grid during slider moves
  });
  const [openTag, setOpenTag] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // ONE tooltip for the whole grid: a stateful component per dot would mean
  // thousands of them. The hovered pack is also what re-measures the tooltip,
  // so it follows the cursor from dot to dot.
  const [hovered, setHovered] = useState<PackRow | null>(null);
  const { setWrap, tipRef, tipStyle, clearTip } = useTipPlacement(hovered?.tag);
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
                  ? "Import started: progress in the sync bar, the grid appears as packs come in."
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
  // search: match on tag or name, case-insensitive; matches are shown as a
  // NAMED list (the anonymous dots are useless for finding a specific pack)
  const needle = search.trim().toLowerCase();
  const found = needle
    ? cats.flatMap(({ type, packs }) =>
        packs
          .filter(
            (p) =>
              p.tag.toLowerCase().includes(needle) ||
              p.name.toLowerCase().includes(needle)
          )
          .map((p) => ({ type, p }))
      )
    : [];
  return (
    <div className="panel packs-panel">
      <h3>
        Packs
        {atDeb && <span className="dim"> · as of {fmtDate(atDeb)}</span>}
        {data.pending > 0 && (
          <span className="dim"> · import in progress, {fmtNum(data.pending)} to go</span>
        )}
        <input
          className="pack-search"
          type="search"
          placeholder="Find a pack (tag or name)…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="pack-resync"
          title="Re-list every pack category and fetch anything missing (resumable; already-imported packs cost nothing)"
          onClick={() => {
            void postPacksImport().then((r) => {
              setImportMsg(
                r.ok
                  ? "Re-sync started: missing packs are being fetched (sync bar)."
                  : `Failed: ${r.error ?? "unknown"}`
              );
              setTimeout(() => void refetch(), 5000);
            });
          }}
        >
          ↻ Re-sync
        </button>
      </h3>
      {importMsg && <p className="set-note">{importMsg}</p>}
      {needle && (
        <div className="pack-results">
          {found.length === 0 && <span className="dim">No pack matches.</span>}
          {found.slice(0, 50).map(({ type, p }) => (
            <button
              key={p.tag}
              className="pack-result"
              onClick={() => setOpenTag(p.tag)}
            >
              <span className={`pack-dot pack-${packState(p)}`} />
              <b>({p.tag})</b> {p.name}
              <span className="dim">
                {" "}· {TYPE_LABELS[type] ?? type} · {p.played}/{p.total}
                {p.fced >= p.total && p.total > 0 ? " · full FC" : ""}
              </span>
            </button>
          ))}
          {found.length > 50 && (
            <span className="dim">…{found.length - 50} more, refine the search</span>
          )}
        </div>
      )}
      {!needle && cats.map(({ type, packs }) => {
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
                  onMouseEnter={(e) => {
                    setWrap(e.currentTarget);
                    setHovered(p);
                  }}
                  onMouseLeave={() => {
                    setHovered(null);
                    clearTip();
                  }}
                  onClick={() => setOpenTag(p.tag)}
                />
              ))}
            </div>
          </div>
        );
      })}
      {hovered && (
        <div ref={tipRef} className="bar-tip" style={tipStyle}>
          <div className="bar-tip-row">
            <b className="bar-tip-title">
              ({hovered.tag}) {hovered.name}
            </b>
          </div>
          <div className="bar-tip-row">
            <span className="gauge-dot" style={{ background: "var(--accent)" }} />{" "}
            Cleared{" "}
            <b>
              {fmtNum(hovered.played)} / {fmtNum(hovered.total)}
            </b>
            <span className="tip-dim">
              {" "}
              ({pct(hovered.played, hovered.total)})
            </span>
          </div>
          <div className="bar-tip-row">
            <span className="gauge-dot" style={{ background: "var(--yellow)" }} /> FC{" "}
            <b>{fmtNum(hovered.fced)}</b>
            <span className="tip-dim"> ({pct(hovered.fced, hovered.total)})</span>
          </div>
          <div className="bar-tip-row tip-dim">
            {TYPE_LABELS[hovered.type] ?? hovered.type}
            {hovered.date ? ` · ${fmtDate(hovered.date)}` : ""}
            {STATE_LABELS[packState(hovered)]}
          </div>
        </div>
      )}
      {openTag && (
        <PackModal
          tag={openTag}
          ruleset={ruleset}
          at={atDeb}
          pool={pool}
          keys={keys}
          scope={scope}
          onViewPack={onViewPack}
          onClose={() => setOpenTag(null)}
        />
      )}
    </div>
  );
});
