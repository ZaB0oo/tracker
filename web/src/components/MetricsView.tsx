import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteMetric, fetchMetrics, type Metric } from "../api";
import { fmtNum, fmtDate } from "../format";
import { EvoChart } from "./EvoChart";
import { MetricBuilder } from "./MetricBuilder";

const fmtBig = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}B`
    : fmtNum(n);

function srLabel(sr: number): string {
  return sr >= 10 ? "10★+" : `${sr}–${sr + 1}★`;
}

function MetricCard({
  m,
  onDelete,
  onEdit,
}: {
  m: Metric;
  onDelete: (id: number) => void;
  onEdit: (m: Metric) => void;
}) {
  const fmtV = m.params.kind === "ranked_score" ? fmtBig : fmtNum;
  const isRanked = m.params.kind === "ranked_score";
  const totalMode = m.params.progressMode === "total" && m.params.kind === "count";
  const achieved = [...m.milestones].reverse();
  // Per-bucket completion: maps matched / all maps in the star-rating band.
  // (Country #1 metrics compare against every map in the band, not just my #1s.)
  const hasTotals = m.bySr.some((b) => b.total > 0);
  const srMax = Math.max(...m.bySr.map((b) => b.value), 1);
  const srTitle = "Completion by star rating";
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

      <div className="goal-bar metric-bar">
        <div className="goal-bar-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
        <span>{label}</span>
      </div>

      <div className="metric-body">
        {!isRanked && (
        <div className="metric-sr">
          <div className="metric-sub">{srTitle}</div>
          {m.bySr.map((b) => {
            const w = hasTotals
              ? b.total > 0 ? (b.value / b.total) * 100 : 0
              : (b.value / srMax) * 100;
            return (
              <div key={b.sr} className="metric-sr-row">
                <span className="metric-sr-label">{srLabel(b.sr)}</span>
                <div className="metric-sr-bar">
                  <div className="metric-sr-fill" style={{ width: `${w}%` }} />
                </div>
                <span className="metric-sr-val">
                  {hasTotals ? `${fmtV(b.value)}/${fmtV(b.total)}` : fmtV(b.value)}
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
export function MetricsView() {
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
