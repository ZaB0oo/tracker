import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteMetric,
  fetchMetrics,
  fetchMetricPpTop,
  type Metric,
  type MetricBreakdown,
} from "../api";
import { displayGrade, fmtCompact, fmtDate, fmtNum } from "../format";
import { EvoChart } from "./EvoChart";
import { GradeBadge } from "./GradeBadge";
import { MissingIcon } from "./Icons";
import { MapModal } from "./MapModal";
import { MetricBuilder } from "./MetricBuilder";

/** Map identity carried by pp-top rows (context menu / details). */
interface CtxMapInfo {
  beatmap_id: number;
  artist: string;
  title: string;
  version: string;
}
type OnMapContext = (e: React.MouseEvent, info: CtxMapInfo) => void;


const BREAKDOWN_TITLES: Record<MetricBreakdown, string> = {
  sr: "star rating", year: "rank year", length: "length", combo: "max combo",
  ar: "AR", od: "OD", cs: "CS", hp: "HP",
};

function bucketLabel(dim: MetricBreakdown, bucket: number | string): string {
  const n = Number(bucket);
  switch (dim) {
    case "sr":
      return n >= 10 ? "10★+" : `${n}–${n + 1}★`;
    case "year":
      return String(bucket);
    case "length":
      return n >= 10 ? "10 min+" : `${n}–${n + 1} min`;
    case "combo":
      return n >= 8 ? "2000+" : `${n * 250}–${(n + 1) * 250}`;
    default:
      return n >= 10 ? "10" : `${n}–${n + 1}`;
  }
}

/** One-line human summary of a metric's conditions (shown under its name). */
function describeParams(p: Metric["params"]): string {
  const parts: string[] = [];
  const rng = (
    min: number | null | undefined,
    max: number | null | undefined,
    label: string,
    unit = ""
  ) => {
    if (min == null && max == null) return;
    if (min != null && max != null) parts.push(`${label} ${min}–${max}${unit}`);
    else if (min != null) parts.push(`${label} ≥ ${min}${unit}`);
    else parts.push(`${label} ≤ ${max}${unit}`);
  };

  const s = p.score;
  if (s.fc === "any") parts.push("FC");
  if (s.fc === "pfc") parts.push("PFC");
  if (s.minGrade) parts.push(`${displayGrade(s.minGrade)}+`);
  rng(s.acc?.min, s.acc?.max, "acc", "%");
  if (s.minClassic) parts.push(`classic ≥ ${fmtCompact(s.minClassic)}`);
  if (s.minScore) parts.push(`std ≥ ${fmtCompact(s.minScore)}`);
  if (s.requiredMods?.length) parts.push(`+${s.requiredMods.join("")}`);
  if (s.allowedMods)
    parts.push(s.allowedMods.length ? `only ${s.allowedMods.join("/")}` : "nomod");
  const counts: [keyof typeof s.counts, string][] = [
    ["n100", "100s"], ["n50", "50s"], ["nMiss", "misses"],
    ["nSliderEnd", "slider ends"], ["imperfections", "imperfections"],
  ];
  for (const [key, label] of counts) rng(s.counts[key]?.min, s.counts[key]?.max, label);

  const m = p.map;
  rng(m.srMin, m.srMax, "", "★");
  rng(m.yearMin, m.yearMax, "year");
  rng(m.lenMin, m.lenMax, "length", "s");
  rng(m.arMin, m.arMax, "AR");
  rng(m.odMin, m.odMax, "OD");
  rng(m.csMin, m.csMax, "CS");
  rng(m.hpMin, m.hpMax, "HP");
  rng(m.comboMin, m.comboMax, "combo");
  rng(m.bpmMin, m.bpmMax, "BPM");
  if (m.statuses.length && m.statuses.length < 3) {
    const labels: Record<number, string> = { 1: "ranked", 2: "approved", 4: "loved" };
    parts.push(m.statuses.map((v) => labels[v] ?? v).join("/"));
  }
  if (m.country1) parts.push("country #1");
  rng(m.globalTopMin, m.globalTopMax, "global rank");
  if (m.query?.trim()) parts.push(`“${m.query.trim()}”`);
  if (m.ids?.length) parts.push(`${fmtNum(m.ids.length)}-map pool`);

  if (p.kind === "ranked_score") parts.unshift("ranked score");
  return parts.join(" · ") || "all clears";
}

function MetricCard({
  m,
  gran,
  onDelete,
  onEdit,
  onMissing,
  onCtx,
}: {
  m: Metric;
  gran: "month" | "day";
  onDelete: (id: number) => void;
  onEdit: (m: Metric) => void;
  onMissing: (m: Metric) => void;
  onCtx: OnMapContext;
}) {
  const isRanked = m.params.kind === "ranked_score";
  const isPp = m.params.kind === "pp";
  const fmtV = isRanked
    ? fmtCompact
    : isPp
      ? (v: number) => `${fmtNum(Math.round(v))}pp`
      : fmtNum;
  // pp metrics: top plays as of a selected period (click the curve or pick)
  const [ppPeriod, setPpPeriod] = useState("");
  const nowIso = new Date().toISOString();
  const effPeriod = ppPeriod || (gran === "day" ? nowIso.slice(0, 10) : nowIso.slice(0, 7));
  const { data: ppTop } = useQuery({
    queryKey: ["pp-top", m.id, effPeriod],
    queryFn: () => fetchMetricPpTop(m.id, effPeriod),
    refetchInterval: 60_000,
    enabled: isPp,
  });
  const totalMode = m.params.progressMode === "total" && m.params.kind === "count";
  const achieved = [...m.milestones].reverse();
  // Per-bucket completion: maps matched / all maps in the star-rating band.
  // (Country #1 metrics compare against every map in the band, not just my #1s.)
  const dim = (m.params.breakdown ?? "sr") as MetricBreakdown;
  const hasTotals = m.byBucket.some((b) => b.total > 0);
  const srMax = Math.max(...m.byBucket.map((b) => b.value), 1);
  const srTitle = `Completion by ${BREAKDOWN_TITLES[dim]}`;
  // days between consecutive milestones (ascending order)
  const daysBetween = new Map<number, number>();
  for (let i = 1; i < m.milestones.length; i++) {
    daysBetween.set(
      m.milestones[i].threshold,
      Math.round(
        (Date.parse(m.milestones[i].at) - Date.parse(m.milestones[i - 1].at)) / 86_400_000
      )
    );
  }

  // Progress bar: X / total available (total mode) or toward the next step.
  let pct: number;
  let label: string;
  if (totalMode) {
    pct = m.total > 0 ? (m.count / m.total) * 100 : 0;
    label = `${fmtV(m.count)} / ${fmtV(m.total)} (${pct.toFixed(2)}%)`;
  } else {
    const reached = Math.floor(m.count / m.step) * m.step;
    pct = ((m.count - reached) / m.step) * 100;
    label = `${fmtV(m.count)} — next: ${fmtV(reached + m.step)} (${pct.toFixed(1)}%)`;
  }

  return (
    <div className="panel metric-card">
      <div className="metric-head">
        <h3>{m.name}</h3>
        {isPp && m.pp && (
          <span className="pp-dim">
            incl. {Math.round(m.pp.bonus)} bonus · {fmtNum(m.pp.scoreCount)} scores
          </span>
        )}
        {!isRanked && !isPp && (
          <button
            className="metric-btn"
            title="List the missing maps in the Maps tab"
            onClick={() => onMissing(m)}
          >
            <MissingIcon />
          </button>
        )}
        <button className="metric-btn" title="Edit this metric" onClick={() => onEdit(m)}>
          ✎
        </button>
        <button
          className="metric-btn metric-del"
          title="Delete this metric"
          onClick={() => {
            if (window.confirm(`Delete metric “${m.name}”?`)) onDelete(m.id);
          }}
        >
          ✕
        </button>
      </div>
      <div className="metric-conds" title={describeParams(m.params)}>
        {describeParams(m.params)}
      </div>

      <div className="goal-bar metric-bar">
        <div className="goal-bar-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
        <span>{label}</span>
      </div>

      <div className="metric-body">
        {!isRanked && !isPp && (
        <div className="metric-sr">
          <div className="metric-sub">{srTitle}</div>
          {m.byBucket.map((b) => {
            const w = hasTotals
              ? b.total > 0 ? (b.value / b.total) * 100 : 0
              : (b.value / srMax) * 100;
            const pct = hasTotals && b.total > 0 ? (b.value / b.total) * 100 : null;
            return (
              <div key={String(b.bucket)} className="metric-sr-row">
                <span className="metric-sr-label">{bucketLabel(dim, b.bucket)}</span>
                <div className="metric-sr-bar">
                  <div className="metric-sr-fill" style={{ width: `${w}%` }} />
                </div>
                <span className="metric-sr-val">
                  <b>{fmtV(b.value)}</b>
                  {hasTotals && <span className="metric-sr-total"> / {fmtV(b.total)}</span>}
                  {pct != null && (
                    <span className="metric-sr-pct">{pct.toFixed(1)}%</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        )}

        {!totalMode && achieved.length > 0 && (
          <div className="metric-milestones">
            <div className="metric-sub">Milestones</div>
            <div className="metric-ms-list">
              {achieved.map((ms, i) => (
                <div key={ms.threshold} className={`metric-ms-row${i % 2 ? " row-alt" : ""}`}>
                  <span>{fmtV(ms.threshold)}</span>
                  <span className="metric-ms-date">
                    {fmtDate(ms.at)}
                    {daysBetween.has(ms.threshold) && (
                      <span className="metric-ms-delta"> +{daysBetween.get(ms.threshold)}d</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {m.evolution && m.evolution.length > 1 && (
        <div className="metric-evo">
          <EvoChart
            data={m.evolution}
            fmtY={fmtV}
            bare
            onPick={isPp ? setPpPeriod : undefined}
          />
        </div>
      )}
      {isPp && (
        <div className="pp-top">
          <div className="pp-top-head">
            <span className="metric-sub">
              Top plays as of {effPeriod}
              {(() => {
                const at = m.evolution?.filter((pt) => pt.period <= effPeriod).at(-1);
                return at ? (
                  <b className="pp-top-at"> · {fmtNum(Math.round(at.value))}pp</b>
                ) : null;
              })()}
              <span className="pp-dim"> (click the curve to pick)</span>
            </span>
            <input
              type={gran === "day" ? "date" : "month"}
              value={effPeriod}
              onChange={(e) => setPpPeriod(e.target.value)}
            />
          </div>
          {ppTop && ppTop.rows.length === 0 && (
            <p className="goal-note">No pp play up to this {gran === "day" ? "day" : "month"}.</p>
          )}
          <div className="pp-top-list">
            {ppTop?.rows.map((r, i) => {
              const sr = r.sr_mods ?? r.star_rating;
              return (
                <div
                  key={r.beatmap_id}
                  className={`pp-top-row${i % 2 ? " row-alt" : ""}`}
                  onDoubleClick={() =>
                    window.open(`https://osu.ppy.sh/b/${r.beatmap_id}`, "_blank")
                  }
                  onContextMenu={(e) => onCtx(e, r)}
                  title="Double-click: open on osu.ppy.sh — right-click: actions"
                >
                  <span className="pp-top-idx">#{i + 1}</span>
                  <b className="pp-top-pp">{r.pp.toFixed(2)}pp</b>
                  <GradeBadge grade={r.rank} width={26} />
                  <span className="pp-top-map">
                    {r.artist} – {r.title} <i>[{r.version}]</i>
                  </span>
                  {r.mods_list.length > 0 && (
                    <span className="pp-top-mods">+{r.mods_list.join("")}</span>
                  )}
                  <span className="pp-top-acc">{(r.accuracy * 100).toFixed(2)}%</span>
                  <span
                    className={`pp-top-sr${r.sr_mods != null ? " pp-top-sr-mod" : ""}`}
                    title={r.sr_mods != null ? "star rating with mods" : undefined}
                  >
                    {sr != null ? `${sr.toFixed(2)}★` : ""}
                  </span>
                  <span className="pp-top-date">{fmtDate(r.ended_at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Metrics tab: user-defined metrics as milestones + optional evolution. */
export function MetricsView({
  onMissingMaps,
}: {
  onMissingMaps: (id: number, name: string) => void;
}) {
  const qc = useQueryClient();
  const [gran, setGran] = useState<"month" | "day">("month");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<Metric | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["metrics", gran],
    queryFn: () => fetchMetrics(gran),
    refetchInterval: 60_000,
  });
  const del = useMutation({
    mutationFn: deleteMetric,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["metrics"] }),
  });
  const [ctx, setCtx] = useState<{ x: number; y: number; row: CtxMapInfo } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const onCtx: OnMapContext = (e, row) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, row });
  };

  if (isLoading) return <div className="panel">Loading metrics…</div>;
  if (error || !data) return <div className="panel">Failed to load.</div>;

  return (
    <div className="dashboard">
      <div className="metrics-toolbar">
        <button className="primary" onClick={() => setBuilderOpen(true)}>
          + New metric
        </button>
        <div className="seg">
          <button className={gran === "month" ? "active" : ""} onClick={() => setGran("month")}>
            Months
          </button>
          <button className={gran === "day" ? "active" : ""} onClick={() => setGran("day")}>
            Days
          </button>
        </div>
        <small>evolution shown per metric · drag a chart to zoom</small>
      </div>

      {data.metrics.length === 0 && (
        <p className="goal-note">No metric yet — create one with “+ New metric”.</p>
      )}
      <div className="metrics-grid">
        {data.metrics.map((m) => (
          <MetricCard
            key={m.id}
            m={m}
            gran={gran}
            onDelete={(id) => del.mutate(id)}
            onEdit={(metric) => setEditing(metric)}
            onMissing={(metric) => onMissingMaps(metric.id, metric.name)}
            onCtx={onCtx}
          />
        ))}
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
          <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
            <div className="ctx-title">
              {ctx.row.artist} – {ctx.row.title} [{ctx.row.version}]
            </div>
            <button
              onClick={() => {
                setDetailId(ctx.row.beatmap_id);
                setCtx(null);
              }}
            >
              Map details
            </button>
            <button
              onClick={() => {
                window.open(`https://osu.ppy.sh/b/${ctx.row.beatmap_id}`, "_blank");
                setCtx(null);
              }}
            >
              Open on osu.ppy.sh
            </button>
            <button
              onClick={() => {
                window.location.href = `osu://b/${ctx.row.beatmap_id}`;
                setCtx(null);
              }}
            >
              Open in osu! (osu!direct)
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(String(ctx.row.beatmap_id));
                setCtx(null);
              }}
            >
              Copy beatmap id
            </button>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(
                  `${ctx.row.artist} - ${ctx.row.title} [${ctx.row.version}]`
                );
                setCtx(null);
              }}
            >
              Copy « artist - title [diff] »
            </button>
          </div>
        </>
      )}
      {detailId != null && (
        <MapModal beatmapId={detailId} onClose={() => setDetailId(null)} />
      )}

      {(builderOpen || editing) && (
        <MetricBuilder
          edit={editing ? { id: editing.id, name: editing.name, params: editing.params } : undefined}
          onClose={() => {
            setBuilderOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            setBuilderOpen(false);
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["metrics"] });
          }}
        />
      )}
    </div>
  );
}
