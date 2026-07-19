import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  DEFAULT_METRIC_PARAMS,
  postMetric,
  previewMetric,
  putMetric,
  type MetricParams,
  type Range,
} from "../api";
import { fmtNum } from "../format";

// osu!std mods grouped by the in-game categories (lazer). AT/CN can't submit a
// score so they're excluded. Fun mods are std-only.
const MOD_GROUPS: { label: string; mods: string[] }[] = [
  { label: "Reduction", mods: ["EZ", "NF", "HT", "DC"] },
  { label: "Increase", mods: ["HR", "SD", "PF", "DT", "NC", "HD", "FL", "BL", "ST", "AC", "TC"] },
  { label: "Automation", mods: ["RX", "AP", "SO"] },
  { label: "Conversion", mods: ["TP", "DA", "CL", "RD", "MR", "AL", "SG"] },
  {
    label: "Fun",
    mods: ["TR", "WG", "SI", "GR", "DF", "WU", "WD", "BR", "AD", "MU", "NS", "MG", "RP", "AS", "FR", "BU", "SY", "DP", "BM"],
  },
];
// count fields: [label, path in score.counts]
const COUNT_FIELDS: { key: keyof MetricParams["score"]["counts"]; label: string }[] = [
  { key: "n100", label: "100s" },
  { key: "n50", label: "50s" },
  { key: "nMiss", label: "Misses" },
  { key: "nSliderEnd", label: "Missed slider ends" },
  { key: "imperfections", label: "Imperfections (100s + slider ends)" },
];
const MAP_FIELDS: { min: keyof MetricParams["map"]; max: keyof MetricParams["map"]; label: string; step: number }[] = [
  { min: "srMin", max: "srMax", label: "Star rating", step: 0.1 },
  { min: "yearMin", max: "yearMax", label: "Year", step: 1 },
  { min: "lenMin", max: "lenMax", label: "Length (s)", step: 1 },
  { min: "arMin", max: "arMax", label: "AR", step: 0.1 },
  { min: "odMin", max: "odMax", label: "OD", step: 0.1 },
  { min: "csMin", max: "csMax", label: "CS", step: 0.1 },
  { min: "hpMin", max: "hpMax", label: "HP", step: 0.1 },
  { min: "comboMin", max: "comboMax", label: "Max combo", step: 1 },
  { min: "bpmMin", max: "bpmMax", label: "BPM", step: 1 },
];
const STATUSES = [
  { v: 1, label: "Ranked" },
  { v: 2, label: "Approved" },
  { v: 4, label: "Loved" },
];

function toNum(v: string): number | null {
  return v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-section">
      <button className="mb-section-head" onClick={() => setOpen((o) => !o)}>
        <span>{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && <div className="mb-section-body">{children}</div>}
    </div>
  );
}

function RangeRow({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: Range;
  onChange: (r: Range) => void;
  step?: number;
}) {
  return (
    <div className="mb-range">
      <span>{label}</span>
      <input
        type="number" step={step} placeholder="min"
        value={value.min ?? ""}
        onChange={(e) => onChange({ ...value, min: toNum(e.target.value) })}
      />
      <input
        type="number" step={step} placeholder="max"
        value={value.max ?? ""}
        onChange={(e) => onChange({ ...value, max: toNum(e.target.value) })}
      />
    </div>
  );
}

/** Metric builder modal with a live count + per-star-rating preview. */
export function MetricBuilder({
  onClose,
  onSaved,
  edit,
}: {
  onClose: () => void;
  onSaved: () => void;
  edit?: { id: number; name: string; params: MetricParams };
}) {
  const [name, setName] = useState(edit?.name ?? "");
  // merge with defaults so older metrics (missing new fields) still work
  const [p, setP] = useState<MetricParams>(
    edit
      ? {
          ...DEFAULT_METRIC_PARAMS,
          ...edit.params,
          progressMode: edit.params.progressMode ?? "milestone",
          step: edit.params.step || 1000,
        }
      : DEFAULT_METRIC_PARAMS
  );
  const [preview, setPreview] = useState<{
    count: number;
    bySr: { sr: number; value: number; total: number }[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const setScore = (patch: Partial<MetricParams["score"]>) =>
    setP((s) => ({ ...s, score: { ...s.score, ...patch } }));
  const setCount = (key: keyof MetricParams["score"]["counts"], r: Range) =>
    setP((s) => ({ ...s, score: { ...s.score, counts: { ...s.score.counts, [key]: r } } }));
  const setMap = (key: keyof MetricParams["map"], v: number | null) =>
    setP((s) => ({ ...s, map: { ...s.map, [key]: v } }));

  // Debounced live preview.
  const paramsKey = useMemo(() => JSON.stringify(p), [p]);
  useEffect(() => {
    const t = setTimeout(() => {
      previewMetric(p).then(setPreview).catch(() => setPreview(null));
    }, 500);
    return () => clearTimeout(t);
  }, [paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (payload: { name: string; params: MetricParams }) =>
      edit
        ? putMetric({ id: edit.id, ...payload })
        : postMetric(payload),
    onSuccess: onSaved,
    onError: (e) => setErr(String(e instanceof Error ? e.message : e)),
  });

  const isCount = p.kind === "count";
  const srMax = Math.max(...(preview?.bySr.map((b) => b.value) ?? [1]), 1);

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal mb-modal">
        <div className="adv-head">
          <h2>{edit ? "Edit metric" : "New metric"}</h2>
          <button className="mm-close" onClick={onClose}>✕</button>
        </div>

        <div className="mb-row">
          <input
            className="mb-name" placeholder="Metric name"
            value={name} onChange={(e) => setName(e.target.value)}
          />
          <select
            value={p.kind}
            onChange={(e) => {
              const kind = e.target.value as MetricParams["kind"];
              setP((s) => ({
                ...s,
                kind,
                step: kind === "ranked_score" ? 10_000_000_000 : 1000,
                progressMode: kind === "ranked_score" ? "milestone" : s.progressMode,
              }));
            }}
          >
            <option value="count">Count maps</option>
            <option value="ranked_score">Ranked score</option>
          </select>
        </div>

        {isCount && (
          <>
            <div className="mb-title">A map counts when I have a score that is…</div>
            <div className="mb-inline">
              <label>
                FC
                <select value={p.score.fc} onChange={(e) => setScore({ fc: e.target.value as "none" | "any" | "pfc" })}>
                  <option value="none">No requirement</option>
                  <option value="any">Full combo</option>
                  <option value="pfc">Perfect (SS combo)</option>
                </select>
              </label>
              <label>
                Grade ≥
                <select value={p.score.minGrade ?? ""} onChange={(e) => setScore({ minGrade: e.target.value || null })}>
                  <option value="">Any</option>
                  <option value="A">A</option>
                  <option value="S">S</option>
                </select>
              </label>
              <label>
                Std score ≥
                <input
                  type="number" placeholder="none"
                  value={p.score.minScore ?? ""}
                  onChange={(e) => setScore({ minScore: toNum(e.target.value) })}
                />
              </label>
            </div>

            <Section title="Mods">
              <div className="mb-mods-label">Allowed mods (empty = any mod allowed):</div>
              {MOD_GROUPS.map((g) => (
                <div key={g.label} className="mb-mod-group">
                  <span className="mb-mod-cat">{g.label}</span>
                  <div className="adv-mods">
                    {g.mods.map((m) => {
                      const on = p.score.allowedMods?.includes(m) ?? false;
                      return (
                        <button
                          key={m} className={`chip ${on ? "on" : ""}`}
                          onClick={() => {
                            const cur = new Set(p.score.allowedMods ?? []);
                            cur.has(m) ? cur.delete(m) : cur.add(m);
                            setScore({ allowedMods: cur.size ? [...cur] : null });
                          }}
                        >
                          {m}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </Section>

            <Section title="Hit counts (100s, 50s, misses, slider ends)">
              {COUNT_FIELDS.map((f) => (
                <RangeRow
                  key={f.key} label={f.label}
                  value={p.score.counts[f.key]}
                  onChange={(r) => setCount(f.key, r)}
                />
              ))}
            </Section>
          </>
        )}

        <div className="mb-title">{isCount ? "On maps matching…" : "On maps matching…"}</div>
        <Section title="Map filters (star rating, year, length, AR/OD/CS/HP…)">
          {MAP_FIELDS.map((f) => (
            <RangeRow
              key={f.min} label={f.label} step={f.step}
              value={{ min: p.map[f.min] as number | null, max: p.map[f.max] as number | null }}
              onChange={(r) => { setMap(f.min, r.min); setMap(f.max, r.max); }}
            />
          ))}
          <div className="mb-inline">
            {STATUSES.map((o) => (
              <label key={o.v} className="mb-check">
                <input
                  type="checkbox"
                  checked={p.map.statuses.includes(o.v)}
                  onChange={() =>
                    setP((s) => ({
                      ...s,
                      map: {
                        ...s.map,
                        statuses: s.map.statuses.includes(o.v)
                          ? s.map.statuses.filter((x) => x !== o.v)
                          : [...s.map.statuses, o.v],
                      },
                    }))
                  }
                />
                {o.label}
              </label>
            ))}
            <label className="mb-check">
              <input
                type="checkbox"
                checked={p.map.country1}
                onChange={(e) => setP((s) => ({ ...s, map: { ...s.map, country1: e.target.checked } }))}
              />
              Country #1 only
            </label>
          </div>
        </Section>

        <div className="mb-title">Display</div>
        <div className="mb-inline">
          <label>
            Progress
            <select
              value={p.progressMode}
              onChange={(e) =>
                setP((s) => ({ ...s, progressMode: e.target.value as "milestone" | "total" }))
              }
            >
              <option value="milestone">Milestones (every N)</option>
              {isCount && <option value="total">Total (X / all available maps)</option>}
            </select>
          </label>
          {p.progressMode === "milestone" && (
            <label>
              every
              <input
                type="number" min={1}
                value={p.step}
                onChange={(e) => setP((s) => ({ ...s, step: Number(e.target.value) || 1 }))}
              />
            </label>
          )}
          <label className="mb-check">
            <input
              type="checkbox" checked={p.showEvolution}
              onChange={(e) => setP((s) => ({ ...s, showEvolution: e.target.checked }))}
            />
            Show evolution curve
          </label>
        </div>

        <div className="mb-preview">
          <div className="mb-preview-count">
            {isCount ? "Maps matching now: " : "Ranked score now: "}
            <b>{preview ? fmtNum(preview.count) : "…"}</b>
          </div>
          {preview && preview.bySr.length > 0 && (
            <div className="mb-preview-sr">
              {preview.bySr.map((b) => (
                <div key={b.sr} className="mb-sr-col" title={`${b.sr}★: ${b.value}`}>
                  <div className="mb-sr-bar" style={{ height: `${(b.value / srMax) * 100}%` }} />
                  <span>{b.sr}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {err && <div className="goal-form-err">{err}</div>}
        <div className="adv-actions">
          <button
            className="primary"
            disabled={save.isPending || !name.trim()}
            onClick={() => { setErr(null); save.mutate({ name: name.trim(), params: p }); }}
          >
            {save.isPending ? "Saving…" : edit ? "Save changes" : "Create metric"}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  );
}
