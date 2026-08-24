import { displayGrade, fmtNum, ppText } from "../format";
import { rulesetStatFields } from "../rulesets";
import { FC_LABELS, type MapDetail } from "../types";
import { useEscape } from "../useEscape";

type ScoreRow = MapDetail["scores"][number];

/** display order of the hit keys; anything unknown lands after, name as-is */
const HIT_ORDER = [
  "perfect", "great", "good", "ok", "meh", "miss",
  "large_tick_hit", "large_tick_miss", "slider_tail_hit",
  "small_tick_hit", "small_tick_miss", "small_bonus", "large_bonus",
];
const HIT_LABELS: Record<string, string> = {
  perfect: "Perfect", great: "Great", good: "Good", ok: "Ok", meh: "Meh",
  miss: "Miss",
  large_tick_hit: "Slider tick", large_tick_miss: "Tick miss",
  slider_tail_hit: "Slider end",
  small_tick_hit: "Small tick", small_tick_miss: "Small tick miss",
  small_bonus: "Spinner spin", large_bonus: "Spinner bonus",
};
/** per-ruleset wording where the generic name would be wrong */
const RULESET_LABELS: Record<number, Record<string, string>> = {
  1: { great: "Great", ok: "Good (150)" },
  2: {
    great: "Fruit", large_tick_hit: "Droplet", miss: "Miss",
    small_tick_hit: "Tiny droplet", small_tick_miss: "Tiny miss",
  },
  3: { perfect: "Perfect (305)", great: "Great (300)", good: "Good (200)" },
};
/** official lazer judgement colours (OsuColour.ForHitResult) */
const hitTone = (k: string): string =>
  k.includes("miss") ? "sc-red"
  : k === "perfect" ? "sc-blue-light"
  : k === "great" || k.includes("tick_hit") || k === "slider_tail_hit" ? "sc-blue"
  : k === "good" ? "sc-green-light"
  : k === "ok" ? "sc-green"
  : k === "meh" ? "sc-yellow"
  : "";

function parseHits(json: string | null): Record<string, number> {
  try {
    const v: unknown = JSON.parse(json || "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

type Mod = { acronym: string; settings?: Record<string, unknown> };
function parseMods(raw: string): Mod[] {
  try {
    const m = JSON.parse(raw) as Mod[];
    return Array.isArray(m) ? m.filter((x) => x?.acronym) : [];
  } catch {
    return [];
  }
}

/**
 * CS/AR/OD/HP as PLAYED: HR/EZ multipliers, DA overrides, and for osu! the
 * AR/OD the rate turns them into (a DT AR9 reads like AR10.3). The formulas
 * are std's; other rulesets stop after the mod adjustments.
 */
function effectiveAttrs(
  map: MapDetail["map"],
  mods: Mod[],
  rate: number | null,
  ruleset: number
): { cs: number | null; ar: number | null; od: number | null; hp: number | null } {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  let { cs, ar, od, hp } = map;
  const has = (a: string) => mods.some((m) => m.acronym === a);
  if (has("HR")) {
    cs = cs != null ? Math.min(10, cs * 1.3) : null;
    ar = ar != null ? Math.min(10, ar * 1.4) : null;
    od = od != null ? Math.min(10, od * 1.4) : null;
    hp = hp != null ? Math.min(10, hp * 1.4) : null;
  } else if (has("EZ")) {
    cs = cs != null ? cs / 2 : null;
    ar = ar != null ? ar / 2 : null;
    od = od != null ? od / 2 : null;
    hp = hp != null ? hp / 2 : null;
  }
  const da = mods.find((m) => m.acronym === "DA")?.settings;
  if (da) {
    cs = num(da.circle_size) ?? cs;
    ar = num(da.approach_rate) ?? ar;
    od = num(da.overall_difficulty) ?? od;
    hp = num(da.drain_rate) ?? hp;
  }
  if (ruleset === 0 && rate != null && rate !== 1) {
    if (ar != null) {
      const preempt = (ar <= 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5)) / rate;
      ar = preempt > 1200 ? (1800 - preempt) / 120 : 5 + (1200 - preempt) / 150;
    }
    // OD through the Great hit window (80 - 6*OD ms)
    if (od != null) od = (80 - (80 - 6 * od) / rate) / 6;
  }
  return { cs, ar, od, hp };
}

const att = (v: number | null): string =>
  v == null ? "—" : (Math.round(v * 10) / 10).toString();

/** "Played on 19 August 2026 18:10", the game's wording */
const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];
const playedOn = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** grade hues, same as the badges and the scatter */
const GRADE_TONES: Record<string, string> = {
  D: "#f25c5c", C: "#f2984e", B: "#eec04c", A: "#88e05a",
  S: "#40d1c0", SH: "#b3f0e8", X: "#ff66aa", XH: "#ffc2dd",
};
/** the game's accuracy circle spans 60%…100% around the full ring */
const RING_FLOOR = 0.6;
/** the outer zone ring, clockwise from the top: each coloured segment ends
 * on its grade badge, the top sliver past A is S/SS territory — the same
 * arrangement as the game's results screen */
const RING_ZONES: { from: number; to: number; g: string | null; color: string }[] = [
  { from: 0.012, to: 0.32, g: "D", color: "#ff5a5a" },
  { from: 0.32, to: 0.63, g: "C", color: "#ff9e4d" },
  { from: 0.63, to: 0.83, g: "B", color: "#ffd24d" },
  { from: 0.83, to: 0.95, g: "A", color: "#9bd94a" },
  { from: 0.95, to: 0.988, g: null, color: "#45d8c2" },
];
/** the primary judgement keys get the big boxed row, the rest go below */
const PRIMARY_HITS = new Set(["perfect", "great", "good", "ok", "meh", "miss"]);
/** always shown for the ruleset, zeroes included — the game's card shows
 * MISS 0, an absent box reads as a missing stat */
const DEFAULT_HITS: Record<number, string[]> = {
  0: ["great", "ok", "meh", "miss"],
  1: ["great", "ok", "miss"],
  2: ["great", "large_tick_hit", "small_tick_hit", "miss"],
  3: ["perfect", "great", "good", "ok", "meh", "miss"],
};

/** an arc segment path along the circle (fractions of a turn, from the top) */
function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const a0 = from * 2 * Math.PI - Math.PI / 2;
  const a1 = to * 2 * Math.PI - Math.PI / 2;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${x1} ${y1}`;
}

/**
 * The game's results ring: the circle spans 60–100% accuracy, the teal arc
 * is this score's accuracy, a thin outer ring shows the grade zones with a
 * letter pill on each, and the earned grade sits creme in the middle.
 */
function AccRing({ acc, grade }: { acc: number; grade: string }) {
  const S = 200;
  const M = S / 2;
  const R = 60;
  const RZ = R + 16; // zone ring + badge radius, clear of the fat arc
  const C = 2 * Math.PI * R;
  const label = displayGrade(grade);
  const silver = grade === "XH" || grade === "SH";
  const frac = Math.max(0.004, Math.min(1, (acc - RING_FLOOR) / (1 - RING_FLOOR)));
  const gap = 5; // px notch at the arc's start, like the game
  const pos = (t: number, rr: number) => {
    const ang = t * 2 * Math.PI - Math.PI / 2;
    return { x: M + rr * Math.cos(ang), y: M + rr * Math.sin(ang) };
  };
  return (
    <svg className="sc-ring-svg" width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
      <defs>
        <linearGradient id="scRingGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#96f4e4" />
          <stop offset="100%" stopColor="#3ecfc0" />
        </linearGradient>
      </defs>
      <circle cx={M} cy={M} r={R} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={11} />
      <circle
        cx={M} cy={M} r={R} fill="none"
        stroke="url(#scRingGrad)" strokeWidth={11} strokeLinecap="round"
        strokeDasharray={`${Math.max(1, frac * C - gap * 2)} ${C}`}
        strokeDashoffset={-gap}
        transform={`rotate(-90 ${M} ${M})`}
      />
      {/* the grade zones, a thin ring outside the arc: contiguous segments
          with clean butt cuts — the joints sit under the badges, only the
          top gap (ring start/end) stays open, like the game */}
      {RING_ZONES.map((z) => (
        <path
          key={z.from}
          d={arcPath(M, M, RZ, z.from, z.to)}
          fill="none" stroke={z.color} strokeWidth={3.5} strokeLinecap="butt"
          opacity={0.95}
        />
      ))}
      {/* each badge sits at the end of its zone's segment */}
      {RING_ZONES.filter((z) => z.g != null).map((z) => {
        const m = pos(z.to, RZ);
        const hit = z.g === label[0] && label.length === 1;
        return (
          <g key={`b${z.g}`}>
            <rect
              x={m.x - 12} y={m.y - 8} width={24} height={16} rx={8}
              fill={z.color}
              stroke={hit ? "#fff" : "rgba(0,0,0,0.4)"} strokeWidth={hit ? 1.5 : 1}
            />
            <text
              x={m.x} y={m.y + 3.5} textAnchor="middle"
              fontSize={10} fontWeight={900} fill="#241b31"
            >
              {z.g}
            </text>
          </g>
        );
      })}
      <text
        x={M} y={label.length > 1 ? M + 14 : M + 20}
        textAnchor="middle"
        fontSize={label.length > 2 ? 36 : label.length > 1 ? 46 : 58}
        fontWeight={900} fill={silver ? "#e3ecf5" : "#fff2d5"}
        style={{ filter: "drop-shadow(0 2px 5px rgba(0,0,0,0.55))" }}
      >
        {label}
      </text>
    </svg>
  );
}

/**
 * One score, unfolded — osualt-style card: the map's cover behind, grade and
 * score front and center, then the labeled tiles (acc/combo/pp, every hit
 * count against the map's maximums, the difficulty settings as played).
 * Opens from any score row; stacks over the map modal.
 */
export function ScoreCard({
  score,
  map,
  ruleset = 0,
  isBest = false,
  onClose,
}: {
  score: ScoreRow;
  map: MapDetail["map"];
  ruleset?: number;
  isBest?: boolean;
  onClose: () => void;
}) {
  useEscape(onClose);
  const hits = parseHits(score.statistics);
  const maxs = parseHits(score.maximum_statistics);
  // ignore_*/legacy_* are bookkeeping, not judgements
  const keys = [
    ...new Set([
      ...(DEFAULT_HITS[ruleset] ?? []),
      ...Object.keys(hits),
      ...Object.keys(maxs),
    ]),
  ]
    .filter((k) => !k.startsWith("ignore") && !k.startsWith("legacy"))
    .sort((a, b) => {
      const ia = HIT_ORDER.indexOf(a);
      const ib = HIT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  const label = (k: string) =>
    RULESET_LABELS[ruleset]?.[k] ?? HIT_LABELS[k] ?? k.replaceAll("_", " ");
  const mods = parseMods(score.mods);
  const sr = score.sr_mods ?? map.star_rating;
  const eff = effectiveAttrs(map, mods, score.rate, ruleset);
  const stats = rulesetStatFields(ruleset);
  return (
    <>
      <div className="menu-overlay score-card-overlay modal-overlay" onClick={onClose} />
      <div
        className="score-card"
        style={{
          backgroundImage: `url(https://assets.ppy.sh/beatmaps/${map.beatmapset_id}/covers/card@2x.jpg)`,
        }}
      >
        <div className="sc-inner">
          <button className="mm-close" onClick={onClose}>
            ✕
          </button>
          <div className="sc-map">
            <b>{map.title}</b>
            <span>{map.artist}</span>
          </div>
          <div className="sc-ring" title={`${(score.accuracy * 100).toFixed(2)}% accuracy`}>
            <AccRing acc={score.accuracy} grade={score.rank} />
          </div>
          <div className="sc-score">
            {fmtNum(score.classic_total_score ?? score.total_score)}
          </div>
          <div className="sc-sub">
            {score.classic_total_score != null
              ? `${fmtNum(score.total_score)} standardised`
              : "standardised"}
          </div>
          <div className="sc-chips">
            {sr != null && (
              <span
                className="mm-stat sc-star"
                title={score.sr_mods != null ? "Star rating of the mods played" : "Star rating"}
              >
                ★ {sr.toFixed(2)}
              </span>
            )}
            {mods.length > 0 && (
              <span className="mm-stat">{mods.map((m) => m.acronym).join(" ")}</span>
            )}
            {score.rate != null && score.rate !== 1 && (
              <span className="mm-stat">{score.rate}x</span>
            )}
            <span className={`mm-stat fc fc-${score.fc_state}`}>
              {FC_LABELS[score.fc_state]}
            </span>
            {isBest && (
              <span className="mm-stat mm-gold" title="The score that counts on the leaderboard">
                BEST
              </span>
            )}
          </div>
          <div className="sc-diff">
            <b>{map.version}</b>
            <span>mapped by {map.creator}</span>
          </div>
          {/* boxed stat tiles, like the game's score card: the headline three
              first, then the judgements against the map's maximums */}
          <div className="sc-tiles">
            <div className="sc-tile">
              <span className="sc-lab">Accuracy</span>
              <b>{(score.accuracy * 100).toFixed(2)}%</b>
            </div>
            <div className="sc-tile">
              <span className="sc-lab">Max combo</span>
              <b>
                {fmtNum(score.max_combo)}
                {map.max_combo != null && <i> /{fmtNum(map.max_combo)}x</i>}
              </b>
            </div>
            <div
              className="sc-tile"
              title={
                score.pp == null && ppText(score) !== ""
                  ? "Estimated locally (no official pp)"
                  : undefined
              }
            >
              <span className="sc-lab">pp</span>
              <b>{ppText(score) || "—"}</b>
            </div>
          </div>
          {keys.filter((k) => PRIMARY_HITS.has(k)).length > 0 && (
            <div className="sc-tiles">
              {keys
                .filter((k) => PRIMARY_HITS.has(k))
                .map((k) => (
                  <div key={k} className={`sc-tile ${hitTone(k)}`}>
                    <span className="sc-pill">{label(k)}</span>
                    <b>
                      {fmtNum(hits[k] ?? 0)}
                      {maxs[k] != null && <i> /{fmtNum(maxs[k])}</i>}
                    </b>
                  </div>
                ))}
            </div>
          )}
          {keys.filter((k) => !PRIMARY_HITS.has(k)).length > 0 && (
            <div className="sc-tiles">
              {keys
                .filter((k) => !PRIMARY_HITS.has(k))
                .map((k) => (
                  <div key={k} className={`sc-tile ${hitTone(k)}`}>
                    <span className="sc-pill">{label(k)}</span>
                    <b>
                      {fmtNum(hits[k] ?? 0)}
                      {maxs[k] != null && <i> /{fmtNum(maxs[k])}</i>}
                    </b>
                  </div>
                ))}
            </div>
          )}
          <div className="sc-cols sc-cols-sub">
            {(
              [
                ...(stats.cs ? ([[stats.csLabel, eff.cs]] as const) : []),
                ["OD", eff.od],
                ["HP", eff.hp],
                ...(stats.ar ? ([["AR", eff.ar]] as const) : []),
              ] as [string, number | null][]
            ).map(([k, v]) => (
              <div key={k} className="sc-col">
                <span>{k}</span>
                <b>{att(v)}</b>
              </div>
            ))}
          </div>
          <div className="sc-foot">
            Played on {playedOn(score.ended_at)} ·{" "}
            <a
              href={`https://osu.ppy.sh/scores/${score.id}`}
              target="_blank"
              rel="noreferrer"
            >
              score {score.id}
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
