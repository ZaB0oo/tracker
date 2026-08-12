import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  DEFAULT_METRIC_PARAMS,
  fetchFilterBounds,
  postMetric,
  previewMetric,
  putMetric,
  type MetricBreakdown,
  type MetricParams,
  type Range,
} from "../api";
import { displayGrade, fmtNum } from "../format";
import { RULESET_HIT_FIELDS, RULESET_MOD_GROUPS, RULESET_NAMES, rulesetStatFields } from "../rulesets";
// count fields: [label, path in score.counts]
const COUNT_FIELDS: { key: keyof MetricParams["score"]["counts"]; label: string }[] = [
  { key: "n100", label: "100s" },
  { key: "n50", label: "50s" },
  { key: "nMiss", label: "Misses" },
  { key: "nSliderEnd", label: "Missed slider ends" },
  { key: "imperfections", label: "Imperfections (100s + slider ends)" },
];
const CUR_YEAR = new Date().getUTCFullYear();
interface MapField {
  min: keyof MetricParams["map"];
  max: keyof MetricParams["map"];
  label: string;
  step: number;
  lo: number;
  hi: number;
}
const GRADES = ["XH", "X", "SH", "S", "A", "B", "C", "D"];
const STATUSES = [
  { v: 1, label: "Ranked" },
  { v: 2, label: "Approved" },
  { v: 4, label: "Loved" },
];

function toNum(v: string): number | null {
  return v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * Extracts beatmap ids from free text: plain numbers, or osu.ppy.sh links
 * (`...#osu/123`, `/b/123`, `/beatmaps/123`). One per line or comma/space
 * separated.
 */
function parseMapIds(text: string): number[] {
  const ids = new Set<number>();
  for (const token of text.split(/[\s,;]+/)) {
    if (!token) continue;
    const link = token.match(/#osu\/(\d+)|\/b\/(\d+)|\/beatmaps\/(\d+)/);
    const raw = link ? link[1] ?? link[2] ?? link[3] : /^\d+$/.test(token) ? token : null;
    if (raw) ids.add(Number(raw));
  }
  return [...ids];
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
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
        type="number" step={step} min={0} placeholder="min"
        value={value.min ?? ""}
        onChange={(e) => onChange({ ...value, min: toNum(e.target.value.replace(/-/g, "")) })}
      />
      <input
        type="number" step={step} min={0} placeholder="max"
        value={value.max ?? ""}
        onChange={(e) => onChange({ ...value, max: toNum(e.target.value.replace(/-/g, "")) })}
      />
    </div>
  );
}

/** Placeholder formatter matching the slider's step — plain digits, no
 * thousands separators (they get cut off and read wrong for years). */
function stepFmt(step: number): (v: number) => string {
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return (v) => (dec ? v.toFixed(dec) : String(Math.round(v)));
}

/**
 * Dual-thumb range slider + manual min/max inputs. A thumb pushed to its end
 * means "no bound" (null), so the untouched slider filters nothing; typed
 * values may exceed the slider's range.
 */
function SliderRow({
  label, lo, hi, step, value, onChange,
}: {
  label: string; lo: number; hi: number; step: number;
  value: Range; onChange: (r: Range) => void;
}) {
  const fmt = stepFmt(step);
  const a = Math.min(Math.max(value.min ?? lo, lo), hi);
  const b = Math.min(Math.max(value.max ?? hi, lo), hi);
  const norm = (v: number) => ((v - lo) / (hi - lo)) * 100;
  return (
    <div className="mb-slider">
      <span className="mb-slider-label">{label}</span>
      <div className="mb-slider-track">
        <div className="mb-slider-rail">
          <div
            className="mb-slider-fill"
            style={{ left: `${norm(a)}%`, width: `${Math.max(norm(b) - norm(a), 0)}%` }}
          />
        </div>
        <input
          type="range" min={lo} max={hi} step={step} value={a}
          // overlapped thumbs: at the RIGHT end the min thumb must be on top
          // (only it can move), at the LEFT end the max thumb must be
          style={{ zIndex: a > (lo + hi) / 2 ? 3 : 1 }}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), b);
            onChange({ ...value, min: v <= lo ? null : v });
          }}
        />
        <input
          type="range" min={lo} max={hi} step={step} value={b}
          style={{ zIndex: 2 }}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), a);
            onChange({ ...value, max: v >= hi ? null : v });
          }}
        />
      </div>
      <input
        type="number" className="mb-slider-num" step={step} min={0}
        placeholder={fmt(lo)} value={value.min ?? ""}
        onChange={(e) => onChange({ ...value, min: toNum(e.target.value.replace(/-/g, "")) })}
      />
      <input
        type="number" className="mb-slider-num" step={step} min={0}
        placeholder={fmt(hi)} value={value.max ?? ""}
        onChange={(e) => onChange({ ...value, max: toNum(e.target.value.replace(/-/g, "")) })}
      />
    </div>
  );
}

/** Metric builder modal with a live count + per-star-rating preview. */
export function MetricBuilder({
  onClose,
  onSaved,
  edit,
  ruleset = 0,
}: {
  onClose: () => void;
  onSaved: () => void;
  edit?: { id: number; name: string; params: MetricParams };
  /** ruleset the metric is created in (edit keeps the metric's own) */
  ruleset?: number;
}) {
  const [name, setName] = useState(edit?.name ?? "");
  // deep-merge with defaults so older metrics (missing new fields) still work
  const [p, setP] = useState<MetricParams>(
    edit
      ? {
          ...DEFAULT_METRIC_PARAMS,
          ...edit.params,
          score: {
            ...DEFAULT_METRIC_PARAMS.score,
            ...edit.params.score,
            counts: {
              ...DEFAULT_METRIC_PARAMS.score.counts,
              ...edit.params.score?.counts,
            },
          },
          map: { ...DEFAULT_METRIC_PARAMS.map, ...edit.params.map },
          breakdown: edit.params.breakdown ?? "sr",
          progressMode: edit.params.progressMode ?? "milestone",
          step: edit.params.step || 1000,
        }
      : { ...DEFAULT_METRIC_PARAMS, ruleset, pool: "all" as const }
  );
  // the step input is kept as text so it can be emptied while typing
  const [stepStr, setStepStr] = useState(String(edit?.params.step || 1000));
  // map-pool text: ids or osu.ppy.sh links, one per line or comma-separated
  const [idsText, setIdsText] = useState(
    edit?.params.map.ids?.length ? edit.params.map.ids.join("\n") : ""
  );
  const [preview, setPreview] = useState<{
    count: number;
    byBucket: { bucket: number | string; value: number; total: number }[];
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const setScore = (patch: Partial<MetricParams["score"]>) =>
    setP((s) => ({ ...s, score: { ...s.score, ...patch } }));
  const setCount = (key: keyof MetricParams["score"]["counts"], r: Range) =>
    setP((s) => ({ ...s, score: { ...s.score, counts: { ...s.score.counts, [key]: r } } }));
  const setMap = (key: keyof MetricParams["map"], v: number | null) =>
    setP((s) => ({ ...s, map: { ...s.map, [key]: v } }));

  // slider bounds = real catalog maxima (highest map SR, longest map, …)
  const rsMetric = p.ruleset ?? 0;
  const { data: bounds } = useQuery({
    queryKey: ["filter-bounds", rsMetric],
    queryFn: () => fetchFilterBounds(rsMetric),
    staleTime: 60 * 60_000,
  });
  const mapFields = useMemo<MapField[]>(() => {
    const sr = bounds?.sr != null ? Math.ceil(bounds.sr * 10) / 10 : 12;
    const len = bounds?.len ?? 1200;
    const combo = bounds?.combo ?? 10000;
    const bpm = bounds?.bpm != null ? Math.ceil(bounds.bpm) : 500;
    const year0 = bounds?.yearMin ?? 2007;
    const glob = bounds?.globalMax ?? 100;
    return [
      { min: "srMin", max: "srMax", label: "Star rating", step: 0.1, lo: 0, hi: sr },
      { min: "yearMin", max: "yearMax", label: "Year", step: 1, lo: year0, hi: CUR_YEAR },
      { min: "lenMin", max: "lenMax", label: "Length (s)", step: 5, lo: 0, hi: len },
      ...(rulesetStatFields(rsMetric).ar
        ? [{ min: "arMin", max: "arMax", label: "AR", step: 0.1, lo: 0, hi: 10 } as const]
        : []),
      { min: "odMin", max: "odMax", label: "OD", step: 0.1, lo: 0, hi: 10 },
      ...(rulesetStatFields(rsMetric).cs
        ? [{ min: "csMin", max: "csMax", label: rulesetStatFields(rsMetric).csLabel, step: 0.1, lo: 0, hi: 10 } as const]
        : []),
      { min: "hpMin", max: "hpMax", label: "HP", step: 0.1, lo: 0, hi: 10 },
      { min: "comboMin", max: "comboMax", label: "Max combo", step: 10, lo: 0, hi: combo },
      { min: "bpmMin", max: "bpmMax", label: "BPM", step: 1, lo: 0, hi: bpm },
      { min: "globalTopMin", max: "globalTopMax", label: "My global rank", step: 1, lo: 1, hi: glob },
    ];
  }, [bounds]);
  const ppHi = bounds?.pp != null ? Math.ceil(bounds.pp) : 2000;

  // Mods chips = the score must contain AT LEAST ONE of the selected mods
  // (anyMods). NM is a normal chip meaning "no mods" (CL alone still counts
  // as nomod: classic scoring doesn't change the play), combinable with the
  // rest. Legacy metrics (requiredMods / allowedMods) pre-fill the selection.
  const modList =
    p.score.anyMods ??
    p.score.requiredMods ??
    (Array.isArray(p.score.allowedMods) ? ["NM"] : []);

  // grade chips; a legacy "Grade ≥" metric pre-fills the equivalent selection
  const gradeList =
    p.score.grades ??
    (p.score.minGrade === "S"
      ? ["S", "SH", "X", "XH"]
      : p.score.minGrade === "A"
        ? ["A", "S", "SH", "X", "XH"]
        : []);

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
  // score conditions apply to count AND weighted-pp metrics (pp filters which
  // scores feed the weighting); only ranked_score sums everything
  const hasScoreConds = p.kind !== "ranked_score";
  const srMax = Math.max(...(preview?.byBucket.map((b) => b.value) ?? [1]), 1);

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal mb-modal">
        <div className="adv-head">
          <h2>
            {edit ? "Edit metric" : "New metric"}
            {rsMetric !== 0 && (
              <span className="pp-dim"> — {RULESET_NAMES[rsMetric]}</span>
            )}
          </h2>
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
              const step =
                kind === "ranked_score" ? 10_000_000_000 : kind === "pp" ? 500 : 1000;
              setStepStr(String(step));
              setP((s) => ({
                ...s,
                kind,
                step,
                progressMode: kind === "count" ? s.progressMode : "milestone",
              }));
            }}
          >
            <option value="count">Count maps</option>
            <option value="ranked_score">Ranked score</option>
            <option value="pp">Weighted pp</option>
          </select>
        </div>

        {hasScoreConds && (
          <>
            <div className="mb-title">
              {isCount
                ? "A map counts when I have a score that is…"
                : "Only weigh scores that are…"}
            </div>
            <div className="mb-inline">
              <label>
                FC
                <select
                  value={p.score.fc}
                  onChange={(e) =>
                    setScore({ fc: e.target.value as MetricParams["score"]["fc"] })
                  }
                >
                  <option value="none">No requirement</option>
                  <option value="any">Full combo</option>
                  <option value="pfc">Perfect (SS combo)</option>
                  <option value="nonfc">Not FC</option>
                </select>
              </label>
              <div className="mb-grades-wrap">
                Grades
                <span className="adv-mods mb-grades">
                  {GRADES.map((g) => {
                    const on = gradeList.includes(g);
                    return (
                      <button
                        key={g} className={`chip ${on ? "on" : ""}`}
                        onClick={() => {
                          const cur = new Set(gradeList);
                          cur.has(g) ? cur.delete(g) : cur.add(g);
                          setScore({
                            grades: cur.size ? [...cur] : null,
                            minGrade: null,
                          });
                        }}
                      >
                        {displayGrade(g)}
                      </button>
                    );
                  })}
                </span>
              </div>
            </div>
            <SliderRow
              label="Standardized" lo={0} step={1000}
              hi={bounds?.stdMax != null ? Math.ceil(bounds.stdMax) : 1_000_000}
              value={{ min: p.score.minScore ?? null, max: p.score.maxScore ?? null }}
              onChange={(r) => setScore({ minScore: r.min, maxScore: r.max })}
            />
            <SliderRow
              label="Accuracy (%)" lo={0} hi={100} step={0.01}
              value={p.score.acc ?? { min: null, max: null }}
              onChange={(r) => setScore({ acc: r })}
            />
            <SliderRow
              label="pp" lo={0} hi={ppHi} step={1}
              value={p.score.pp ?? { min: null, max: null }}
              onChange={(r) => setScore({ pp: r })}
            />

            <Section title="Mods">
              <div className="mb-mods-label">
                Keeps a score if it uses at least one of these mods. NM keeps
                the no-mod scores. Nothing selected: every score counts.
              </div>
              {(RULESET_MOD_GROUPS[rsMetric] ?? RULESET_MOD_GROUPS[0]).map((g) => (
                <div key={g.label} className="mb-mod-group">
                  <span className="mb-mod-cat">{g.label}</span>
                  <div className="adv-mods">
                    {g.mods.map((m) => {
                      const on = modList.includes(m);
                      return (
                        <button
                          key={m} className={`chip ${on ? "on" : ""}`}
                          onClick={() => {
                            const cur = new Set(modList);
                            cur.has(m) ? cur.delete(m) : cur.add(m);
                            setScore({
                              anyMods: cur.size ? [...cur] : null,
                              requiredMods: null,
                              allowedMods: null,
                            });
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

            {rsMetric === 0 ? (
              <Section title="Hit counts (100s, 50s, misses, slider ends)">
                {COUNT_FIELDS.map((f) => (
                  <RangeRow
                    key={f.key} label={f.label}
                    value={p.score.counts[f.key]}
                    onChange={(r) => setCount(f.key, r)}
                  />
                ))}
              </Section>
            ) : (
              <Section title="Hit counts">
                {(RULESET_HIT_FIELDS[rsMetric] ?? []).map((f) => (
                  <RangeRow
                    key={f.key} label={f.label}
                    value={p.score.hits?.[f.key] ?? { min: null, max: null }}
                    onChange={(r) =>
                      setP((s) => ({
                        ...s,
                        score: {
                          ...s.score,
                          hits: { ...s.score.hits, [f.key]: r },
                        },
                      }))
                    }
                  />
                ))}
              </Section>
            )}
          </>
        )}

        <div className="mb-title">On maps matching…</div>
        <Section title="Map filters (star rating, year, length, AR/OD/CS/HP…)">
          <input
            className="mb-query"
            placeholder="Search artist / title / mapper / diff / source / tags…"
            value={p.map.query ?? ""}
            onChange={(e) =>
              setP((s) => ({
                ...s,
                map: { ...s.map, query: e.target.value || null },
              }))
            }
          />
          {mapFields.map((f) => (
            <SliderRow
              key={f.min} label={f.label} step={f.step} lo={f.lo} hi={f.hi}
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

        <Section title="Specific maps (custom map pool)">
          <div className="mb-mods-label">
            Restrict to these maps only — beatmap ids or osu.ppy.sh links
            (…#osu/id, /b/id), one per line or comma-separated. Empty = all maps.
          </div>
          <textarea
            className="mb-ids"
            rows={4}
            placeholder={"1954874\nhttps://osu.ppy.sh/beatmapsets/14850#osu/54138"}
            value={idsText}
            onChange={(e) => {
              const v = e.target.value;
              setIdsText(v);
              const ids = parseMapIds(v);
              setP((s) => ({ ...s, map: { ...s.map, ids: ids.length ? ids : null } }));
            }}
          />
          {idsText.trim() !== "" && (
            <div className="mb-mods-label">
              {p.map.ids?.length ?? 0} map id(s) recognized
            </div>
          )}
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
                value={stepStr}
                onChange={(e) => {
                  const v = e.target.value;
                  setStepStr(v); // can be emptied while typing
                  const n = Number(v);
                  if (n > 0) setP((s) => ({ ...s, step: n }));
                }}
              />
            </label>
          )}
          {isCount && (
            <label>
              Breakdown by
              <select
                value={p.breakdown ?? "sr"}
                onChange={(e) =>
                  setP((s) => ({ ...s, breakdown: e.target.value as MetricBreakdown }))
                }
              >
                <option value="sr">Star rating</option>
                <option value="year">Rank year</option>
                <option value="length">Length</option>
                <option value="combo">Max combo</option>
                <option value="ar">AR</option>
                <option value="od">OD</option>
                <option value="cs">CS</option>
                <option value="hp">HP</option>
              </select>
            </label>
          )}
          {isCount && (
            <label
              className="mb-check"
              title="The count heads down to 0, milestones are celebrated downward, and the list button shows the maps to fix"
            >
              <input
                type="checkbox" checked={p.descending ?? false}
                onChange={(e) => setP((s) => ({ ...s, descending: e.target.checked }))}
              />
              Countdown — maps to fix (goal 0)
            </label>
          )}
          {isCount && (p.descending ?? false) && (
            <div className="mb-invert">
              <label
                className="mb-check"
                title="Ex: to fix = misses >= 1. The score conditions directly describe the maps still to fix."
              >
                <input
                  type="radio" name="mb-cd-mode" checked={!(p.invert ?? false)}
                  onChange={() => setP((s) => ({ ...s, invert: false }))}
                />
                conditions select the maps to fix
              </label>
              <label
                className="mb-check"
                title="Ex: goal = 0x50, 0 miss, imperfections <= 1. The card counts the PLAYED maps whose best does not meet the goal yet — the exact complement of the goal count, even when no direct 'to fix' bounds can express it."
              >
                <input
                  type="radio" name="mb-cd-mode" checked={p.invert ?? false}
                  onChange={() => setP((s) => ({ ...s, invert: true }))}
                />
                conditions describe the GOAL (counts played maps not meeting it)
              </label>
            </div>
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
            {isCount
              ? p.descending
                ? p.invert
                  ? "Maps not meeting the goal yet: "
                  : "Maps to fix now: "
                : "Maps matching now: "
              : p.kind === "pp"
                ? "Weighted pp now: "
                : "Ranked score now: "}
            <b>{preview ? fmtNum(preview.count) : "…"}</b>
          </div>
          {preview && preview.byBucket.length > 0 && (
            <div className="mb-preview-sr">
              {preview.byBucket.map((b) => (
                <div
                  key={String(b.bucket)}
                  className="mb-sr-col"
                  title={`${b.bucket}: ${b.value}`}
                >
                  <div className="mb-sr-bar" style={{ height: `${(b.value / srMax) * 100}%` }} />
                  <span>{String(b.bucket).slice(-2)}</span>
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
