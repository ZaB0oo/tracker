import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteMetric, fetchMetrics, type Metric, type MetricBreakdown } from "../api";
import { displayGrade, fmtCompact, fmtDate, fmtNum } from "../format";
import { EvoChart } from "./EvoChart";
import { MissingIcon } from "./Icons";
import { MetricBuilder } from "./MetricBuilder";


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
  onDelete,
  onEdit,
  onMissing,
}: {
  m: Metric;
  onDelete: (id: number) => void;
  onEdit: (m: Metric) => void;
  onMissing: (m: Metric) => void;
}) {
  const fmtV = m.params.kind === "ranked_score" ? fmtCompact : fmtNum;
  const isRanked = m.params.kind === "ranked_score";
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
        {!isRanked && (
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
        {!isRanked && (
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
          <EvoChart data={m.evolution} fmtY={fmtV} bare />
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
            onDelete={(id) => del.mutate(id)}
            onEdit={(metric) => setEditing(metric)}
            onMissing={(metric) => onMissingMaps(metric.id, metric.name)}
          />
        ))}
      </div>

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
