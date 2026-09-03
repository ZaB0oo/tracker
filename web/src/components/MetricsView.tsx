import { useEffect, useRef, useState } from "react";
import { mapUrl } from "../rulesets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteMetric,
  fetchMetrics,
  fetchMetricPpTop,
  postMetricDiscord,
  reorderMetrics,
  type Metric,
  type MetricBreakdown,
} from "../api";
import { ctxMenuStyle } from "../ctxmenu";
import type { PoolMode } from "../types";
import { appConfirm } from "../dialogs";
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
      // cap aligned with the server buckets (metricEval BUCKETS.combo) and
      // with the dashboard: 10 = 2500+
      return n >= 10 ? "2500+" : `${n * 250}–${(n + 1) * 250}`;
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
  if (s.fc === "nonfc") parts.push("non-FC");
  if (s.minGrade) parts.push(`${displayGrade(s.minGrade)}+`);
  if (s.grades?.length) parts.push(s.grades.map(displayGrade).join("/"));
  rng(s.acc?.min, s.acc?.max, "acc", "%");
  rng(s.pp?.min, s.pp?.max, "pp");
  if (s.minClassic) parts.push(`classic ≥ ${fmtCompact(s.minClassic)}`);
  if (s.minScore != null && s.maxScore != null)
    parts.push(`standardized ${fmtCompact(s.minScore)}–${fmtCompact(s.maxScore)}`);
  else if (s.minScore != null) parts.push(`standardized ≥ ${fmtCompact(s.minScore)}`);
  else if (s.maxScore != null) parts.push(`standardized ≤ ${fmtCompact(s.maxScore)}`);
  if (s.requiredMods?.length) parts.push(`+${s.requiredMods.join("")}`);
  if (s.anyMods?.length) parts.push(`mods ${s.anyMods.join("/")}`);
  if (s.allowedMods) {
    const rest = s.allowedMods.filter((m) => m !== "CL");
    parts.push(rest.length ? `only ${s.allowedMods.join("/")}` : "nomod");
  }
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

  if (p.kind === "ranked_score") parts.unshift("classic score");
  if (p.kind === "std_score") parts.unshift("standardised score");
  if (p.kind === "total_pp") parts.unshift("total pp");
  if (p.kind === "count" && p.descending)
    parts.unshift(p.invert ? "below goal" : "to fix");
  return parts.join(" · ") || "all clears";
}

function MetricCard({
  m,
  gran,
  onDelete,
  onEdit,
  onMissing,
  picked,
  onPick,
  onCtx,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onDrop,
}: {
  m: Metric;
  gran: "month" | "day";
  onDelete: (id: number) => void;
  onEdit: (m: Metric) => void;
  onMissing: (m: Metric) => void;
  /** null = this metric has no "maps left" to speak of (ranked score, pp) */
  picked: boolean | null;
  onPick: (on: boolean) => void;
  onCtx: OnMapContext;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverCard: () => void;
  onDrop: () => void;
}) {
  const [dcBusy, setDcBusy] = useState(false);
  const [dcMsg, setDcMsg] = useState<string | null>(null);
  const isRanked = m.params.kind === "ranked_score" || m.params.kind === "std_score";
  const isPp = m.params.kind === "pp" || m.params.kind === "total_pp";
  // the top-plays list belongs to the weighted metric only: a total-pp sum
  // has no "top 100 that count", every best counts the same
  const isWeightedPp = m.params.kind === "pp";
  const isDesc = m.params.kind === "count" && !!m.params.descending;
  const fmtV = isRanked
    ? fmtCompact
    : m.params.kind === "total_pp"
      ? // millions of pp: the full integer overflows the milestone labels
        (v: number) => `${fmtCompact(Math.round(v))}pp`
      : isPp
        ? (v: number) => `${fmtNum(Math.round(v))}pp`
        : fmtNum;
  // pp metrics: top plays as of a selected period (click the curve or pick)
  const [ppPeriod, setPpPeriod] = useState("");
  // Months <-> Days switch: a stored "2026-09" is invalid for a date input
  // (and vice versa), so the pick resets to the granularity's default
  useEffect(() => setPpPeriod(""), [gran]);
  const nowIso = new Date().toISOString();
  const effPeriod = ppPeriod || (gran === "day" ? nowIso.slice(0, 10) : nowIso.slice(0, 7));
  const { data: ppTop } = useQuery({
    queryKey: ["pp-top", m.id, effPeriod],
    queryFn: () => fetchMetricPpTop(m.id, effPeriod),
    refetchInterval: 60_000,
    enabled: isWeightedPp,
  });
  const totalMode = m.params.progressMode === "total" && m.params.kind === "count";
  const achieved = [...m.milestones].reverse();
  // Per-bucket completion: maps matched / all maps in the star-rating band.
  // (Country #1 metrics compare against every map in the band, not just my #1s.)
  const dim = (m.params.breakdown ?? "sr") as MetricBreakdown;
  const hasTotals = m.byBucket.some((b) => b.total > 0);
  const srMax = Math.max(...m.byBucket.map((b) => b.value), 1);
  const srTitle = `${isDesc ? "Remaining" : "Completion"} by ${BREAKDOWN_TITLES[dim]}`;
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
  // Descending metrics head toward 0 (bar fills as the remaining count drops).
  let pct: number;
  let label: string;
  if (totalMode) {
    if (isDesc) {
      pct = m.total > 0 ? ((m.total - m.count) / m.total) * 100 : 0;
      label = `${fmtV(m.count)} left / ${fmtV(m.total)} (${pct.toFixed(2)}% done)`;
    } else {
      pct = m.total > 0 ? (m.count / m.total) * 100 : 0;
      label = `${fmtV(m.count)} / ${fmtV(m.total)} (${pct.toFixed(2)}%)`;
    }
  } else if (isDesc) {
    if (m.count === 0) {
      pct = 100;
      label = "0 left, done!";
    } else {
      const upper = Math.ceil(m.count / m.step) * m.step;
      pct = ((upper - m.count) / m.step) * 100;
      label = `${fmtV(m.count)} left · next: ${fmtV(upper - m.step)} (${pct.toFixed(1)}%)`;
    }
  } else {
    const reached = Math.floor(m.count / m.step) * m.step;
    pct = ((m.count - reached) / m.step) * 100;
    label = `${fmtV(m.count)} · next: ${fmtV(reached + m.step)} (${pct.toFixed(1)}%)`;
  }

  return (
    <div
      className={`panel metric-card${dragging ? " mc-dragging" : ""}${dropTarget ? " mc-drop" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOverCard();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      <div className="metric-head">
        <span
          className="metric-drag"
          title="Drag to reorder the metrics"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            // drag image = the whole card, not just the handle
            const card = (e.target as HTMLElement).closest(".metric-card");
            if (card) e.dataTransfer.setDragImage(card, 40, 20);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
        >
          ⠿
        </span>
        <h3>{m.name}</h3>
        {isPp && m.pp && (
          <span className="pp-dim">
            incl. {Math.round(m.pp.bonus)} bonus · {fmtNum(m.pp.scoreCount)} scores
          </span>
        )}
        {!isRanked && !isPp && (
          <>
            <label
              className="metric-pick"
              title="Tick a few metrics to list what is left for all of them at once"
            >
              <input
                type="checkbox"
                checked={picked === true}
                onChange={(e) => onPick(e.target.checked)}
              />
            </label>
            <button
              className="metric-btn"
              title={
                isDesc
                  ? "List the maps to fix in the Maps tab"
                  : "List the missing maps in the Maps tab"
              }
              onClick={() => onMissing(m)}
            >
              <MissingIcon />
            </button>
          </>
        )}
        <button
          className="metric-btn"
          title="Post the current progress to the Discord webhook"
          disabled={dcBusy}
          onClick={() => {
            setDcBusy(true);
            setDcMsg(null);
            postMetricDiscord(m.id, describeParams(m.params))
              .then(() => setDcMsg("posted"))
              .catch((e: Error) => setDcMsg(e.message))
              .finally(() => {
                setDcBusy(false);
                setTimeout(() => setDcMsg(null), 5000);
              });
          }}
        >
          ➤
        </button>
        <button className="metric-btn" title="Edit this metric" onClick={() => onEdit(m)}>
          ✎
        </button>
        <button
          className="metric-btn metric-del"
          title="Delete this metric"
          onClick={() => {
            if (appConfirm(`Delete metric “${m.name}”?`)) onDelete(m.id);
          }}
        >
          ✕
        </button>
      </div>
      {dcMsg && <div className="metric-dc-msg">{dcMsg}</div>}
      <div className="metric-conds" title={describeParams(m.params)}>
        {describeParams(m.params)}
      </div>

      <div className="goal-bar metric-bar">
        <div className="goal-bar-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
        <span>{label}</span>
      </div>
      {/* optional second line: the FINAL goal (Arith's request), with the
          overall progress toward it. Ascending metrics only. */}
      {(m.params.goal ?? 0) > 0 && !isDesc && (
        <div className="goal-bar metric-bar metric-final" title="Final goal">
          <div
            className="goal-bar-fill goal-final-fill"
            style={{ width: `${Math.min((m.count / m.params.goal!) * 100, 100)}%` }}
          />
          <span>
            {m.count >= m.params.goal!
              ? `goal ${fmtV(m.params.goal!)} reached!`
              : `goal: ${fmtV(m.params.goal!)} (${((m.count / m.params.goal!) * 100).toFixed(1)}%)`}
          </span>
        </div>
      )}

      <div className="metric-content">
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
            onPick={isWeightedPp ? setPpPeriod : undefined}
            goal={!isDesc ? m.params.goal : undefined}
          />
        </div>
      )}
      {isWeightedPp && (
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
                    window.open(mapUrl(r.beatmap_id, m.params.ruleset ?? 0), "_blank")
                  }
                  onContextMenu={(e) => onCtx(e, r)}
                  title="Double-click: open on osu.ppy.sh · right-click: actions"
                >
                  <span className="pp-top-idx">#{i + 1}</span>
                  <b className="pp-top-pp">{r.pp.toFixed(2)}pp</b>
                  <GradeBadge grade={r.rank} width={26} />
                  <span className="pp-top-map">
                    {r.artist} – {r.title} <i>[{r.version}]</i>
                  </span>
                  {(r.mods_list.length > 0 || (r.rate != null && r.rate !== 1)) && (
                    <span className="pp-top-mods">
                      {r.mods_list.length > 0 ? `+${r.mods_list.join("")}` : ""}
                      {r.rate != null && r.rate !== 1
                        ? `${r.mods_list.length > 0 ? " " : ""}${r.rate}x`
                        : ""}
                    </span>
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
    </div>
  );
}

/** Metrics tab: user-defined metrics as milestones + optional evolution. */
export function MetricsView({
  onMissingMaps,
  ruleset = 0,
}: {
  onMissingMaps: (
    /** one metric, or several (union of what is left for each) */
    ids: number[],
    name: string,
    matching: boolean,
    ruleset?: number,
    pool?: PoolMode
  ) => void;
  ruleset?: number;
}) {
  const qc = useQueryClient();
  const [gran, setGran] = useState<"month" | "day">("month");
  // metrics ticked for a combined list. Reset on ruleset change: the tab only
  // ever shows one mode's metrics, a leftover selection would be invisible.
  const [picked, setPicked] = useState<number[]>([]);
  useEffect(() => setPicked([]), [ruleset]);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<Metric | null>(null);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["metrics", gran],
    queryFn: () => fetchMetrics(gran),
    refetchInterval: 60_000,
  });
  // A metric is evaluated server-side over the whole score history: after
  // saving one, the builder closes and the grid stays unchanged for a few
  // seconds. Without a placeholder it looks like the save did nothing.
  const [pendingCard, setPendingCard] = useState(false);
  useEffect(() => {
    if (!isFetching) setPendingCard(false);
  }, [isFetching]);
  const del = useMutation({
    mutationFn: deleteMetric,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["metrics"] }),
  });
  const reorder = useMutation({
    mutationFn: reorderMetrics,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["metrics"] }),
  });
  // drag & drop reorder: drag a card by its ⠿ handle onto another card
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const endDrag = () => {
    setDragId(null);
    setOverId(null);
  };
  // Native HTML5 drag only auto-scrolls right at the container edges (and
  // fast). Gentle replacement over the REAL scroll container (the app scrolls
  // an inner div, not the page): small dead zone around the middle, speed
  // growing quadratically toward the edges.
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (dragId == null) return;
    let scroller: HTMLElement | null = gridRef.current;
    while (scroller) {
      const st = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(st.overflowY) && scroller.scrollHeight > scroller.clientHeight)
        break;
      scroller = scroller.parentElement;
    }
    if (!scroller) scroller = document.scrollingElement as HTMLElement | null;
    if (!scroller) return;
    const el = scroller;
    const box = el === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : el.getBoundingClientRect();
    let y = -1;
    const onMove = (e: DragEvent) => {
      y = e.clientY;
    };
    window.addEventListener("dragover", onMove);
    const timer = setInterval(() => {
      if (y < 0) return;
      const h = box.bottom - box.top;
      const half = h / 2;
      const dead = h * 0.12;
      const d = y - (box.top + half);
      if (Math.abs(d) <= dead) return;
      const f = Math.min((Math.abs(d) - dead) / (half - dead), 1); // 0..1
      el.scrollTop += Math.sign(d) * Math.ceil(f * f * 10);
    }, 16);
    return () => {
      window.removeEventListener("dragover", onMove);
      clearInterval(timer);
    };
  }, [dragId]);
  const dropOn = (targetId: number) => {
    const ids = (data?.metrics ?? []).map((m) => m.id);
    const from = dragId != null ? ids.indexOf(dragId) : -1;
    const to = ids.indexOf(targetId);
    endDrag();
    if (dragId == null || from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    // forward: land after the target; backward: land before it
    ids.splice(ids.indexOf(targetId) + (from < to ? 1 : 0), 0, dragId);
    reorder.mutate(ids);
  };
  const [ctx, setCtx] = useState<{ x: number; y: number; row: CtxMapInfo } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const onCtx: OnMapContext = (e, row) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, row });
  };

  if (isLoading)
    return (
      <div className="dashboard">
        <div className="metrics-grid">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="panel metric-card">
              <div className="skeleton skeleton-line" style={{ width: "45%" }} />
              <div className="skeleton skeleton-line" style={{ height: 30, width: "70%" }} />
              <div className="skeleton skeleton-line" style={{ height: 60 }} />
            </div>
          ))}
        </div>
      </div>
    );
  if (error || !data) return <div className="panel">Failed to load.</div>;

  return (
    <div className="dashboard">
      <div className="sticky-head">
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
        {isFetching && <span className="loading-chip">Computing…</span>}
      </div>

      {/* Combined list. Only appears once something is ticked, and spells out
          what the button will show — the word "union" is never used. */}
      {(() => {
        const sel = data.metrics.filter(
          (m) => (m.params.ruleset ?? 0) === ruleset && picked.includes(m.id)
        );
        if (sel.length === 0) return null;
        const names = sel.map((m) => m.name);
        const label =
          names.length <= 3
            ? names.join(" + ")
            : `${names.slice(0, 3).join(" + ")} +${names.length - 3}`;
        // each metric applies its own pool inside its own term; this one only
        // means something when they all happen to agree
        const pools = new Set(sel.map((m) => m.params.pool ?? "all"));
        return (
          <div className="metrics-picked">
            <span className="mp-count">
              {sel.length} selected: <b>{label}</b>
            </span>
            <button
              className="primary"
              onClick={() =>
                onMissingMaps(
                  sel.map((m) => m.id),
                  label,
                  false,
                  ruleset,
                  pools.size === 1 ? [...pools][0] : "all"
                )
              }
            >
              Show the maps left for {sel.length === 1 ? "it" : "them"}
            </button>
            <button onClick={() => setPicked([])}>Clear</button>
            <small className="dim">union of the selected metrics</small>
          </div>
        );
      })()}
      </div>
      {data.metrics.length === 0 && (
        <p className="goal-note">No metric yet: create one with “+ New metric”.</p>
      )}
      <div className="metrics-grid" ref={gridRef}>
        {data.metrics
          .filter((m) => (m.params.ruleset ?? 0) === ruleset)
          .map((m) => (
          <MetricCard
            key={m.id}
            m={m}
            gran={gran}
            dragging={dragId === m.id}
            dropTarget={overId === m.id && dragId !== m.id}
            onDragStart={() => setDragId(m.id)}
            onDragEnd={endDrag}
            onDragOverCard={() => setOverId(m.id)}
            onDrop={() => dropOn(m.id)}
            onDelete={(id) => del.mutate(id)}
            onEdit={(metric) => setEditing(metric)}
            picked={
              m.params.kind !== "count"
                ? null
                : picked.includes(m.id)
            }
            onPick={(on) =>
              setPicked((cur) =>
                on ? [...cur, m.id] : cur.filter((id) => id !== m.id)
              )
            }
            onMissing={(metric) =>
              onMissingMaps(
                [metric.id],
                metric.name,
                metric.params.kind === "count" && !!metric.params.descending,
                metric.params.ruleset ?? 0,
                metric.params.pool
              )
            }
            onCtx={onCtx}
          />
        ))}
        {pendingCard && (
          <div className="panel metric-card">
            <div className="skeleton skeleton-line" style={{ width: "45%" }} />
            <div className="skeleton skeleton-line" style={{ height: 30, width: "70%" }} />
            <div className="skeleton skeleton-line" style={{ height: 60 }} />
            <small className="dim">Evaluating the new metric…</small>
          </div>
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
                window.open(mapUrl(ctx.row.beatmap_id, ruleset), "_blank");
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
        <MapModal beatmapId={detailId} ruleset={ruleset} onClose={() => setDetailId(null)} />
      )}

      {(builderOpen || editing) && (
        <MetricBuilder ruleset={ruleset}
          edit={editing ? { id: editing.id, name: editing.name, params: editing.params } : undefined}
          onClose={() => {
            setBuilderOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            // placeholder only for a NEW metric: an edit updates a card that
            // is already on screen, a phantom extra card would be confusing
            setPendingCard(editing == null);
            setBuilderOpen(false);
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ["metrics"] });
          }}
        />
      )}
    </div>
  );
}
