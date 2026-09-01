import { memo, useEffect, useMemo, useRef, useState } from "react";
import { PanelSkeleton } from "./Skeleton";
import { useQuery } from "@tanstack/react-query";
import { fetchMapNames, fetchScatter, type DashScope, type ScatterPoint } from "../api";
import { fmtNum } from "../format";
import { FC_LABELS, GRADE_ORDER, type PoolMode } from "../types";
import { MapModal } from "./MapModal";

// logical drawing space: the canvas is sized to the element's real width at
// devicePixelRatio, so the dots stay crisp at any panel width
const H = 460;
const L = 46;
const RGT = 12;
const T = 10;
const B = 26;
/** the axis floor: everything below (rare) is drawn on the floor line */
const ACC_FLOOR = 0.55;
const HOVER_R = 9;

/** dot colour per FC state (PFC and FC read as one achievement here) */
const FC_KEYS: { label: string; color: string; match: (fc: number) => boolean }[] = [
  { label: "FC", color: "#66ccff", match: (fc) => fc <= 1 },
  { label: FC_LABELS[2], color: "#ff66aa", match: (fc) => fc === 2 },
];
/** dot colour per grade, D..XH (same hues as the grade badges) */
const GRADE_COLORS = [
  "#f25c5c", "#f2984e", "#eec04c", "#88e05a",
  "#40d1c0", "#b3f0e8", "#ff66aa", "#ffc2dd",
];

/** a 1/2/5×10^k step giving at most `target` gridlines over `span` — the
 * loved pool holds aspire maps in the hundreds of stars, a fixed 1★ step
 * would paint a wall of labels */
const niceStep = (span: number, target: number, min: number): number => {
  const raw = Math.max(span, 1e-9) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (pow * m >= raw) return Math.max(min, pow * m);
  return Math.max(min, pow * 10);
};

interface Zoom {
  x0: number;
  x1: number;
  a0: number;
  a1: number;
}

/**
 * Accuracy against difficulty, one dot per map (the best score) — the whole
 * catalog on a canvas, so ~100k dots stay instant. Coloured by grade (or FC
 * state), each legend chip toggling its dots; hovering lists every map under
 * the cursor, clicking opens the nearest one.
 */
export const AccScatterPanel = memo(function AccScatterPanel({
  ruleset = 0,
  pool = "all",
  keys = [],
  scope = "all",
  at = null,
}: {
  ruleset?: number;
  pool?: PoolMode;
  keys?: string[];
  scope?: DashScope;
  /** time machine day: the bests as they stood that evening (null = live) */
  at?: string | null;
}) {
  const { data } = useQuery({
    queryKey: ["scatter", ruleset, pool, keys, scope, at],
    queryFn: () => fetchScatter(ruleset, pool, keys, scope, at),
    refetchInterval: 5 * 60_000,
    // keep the previous cloud while the day's replay computes
    placeholderData: (prev) => prev,
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(1000);
  const [mode, setMode] = useState<"grades" | "fc">("grades");
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [modalId, setModalId] = useState<number | null>(null);
  const [tip, setTip] = useState<{ fx: number; fy: number; ids: number[]; extra: number } | null>(null);
  // drag-a-rectangle zoom: null = the full view
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; zoomed: boolean } | null>(null);
  const [dragBox, setDragBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // middle-button pan: start position + the domain as it was grabbed
  const panRef = useRef<{ sx: number; sy: number; z: Zoom } | null>(null);

  const pts = useMemo(() => data?.points ?? [], [data]);
  // a different point cloud (scope, pool, time machine…) invalidates the zoom
  useEffect(() => setZoom(null), [pts]);
  // key of a point in the current colour mode (grade 0-7, or 0/1 for FC)
  const keyOf = (p: ScatterPoint) => (mode === "grades" ? p[4] : p[3] <= 1 ? 0 : 1);
  const isHidden = (p: ScatterPoint) => hidden.has(keyOf(p));
  // Full extent by default: the hardest ranked maps (13-14★) deserve their
  // place on the axis instead of piling on the right edge. The percentile
  // cap only kicks in when the tail is OUT OF SCALE with the bulk (aspire
  // maps in the hundreds of stars would squash everything into a sliver);
  // capped-out points still pile on the edge, nothing disappears.
  const xMax = useMemo(() => {
    if (pts.length === 0) return 10;
    const srs = pts.map((p) => p[1]).sort((a, b) => a - b);
    const cap = srs[Math.min(srs.length - 1, Math.floor(srs.length * 0.995))];
    // The extent is the highest map still PROPORTIONATE to the bulk (within
    // 3x the 99.5th percentile). Only the out-of-scale tail (loved aspire
    // maps in the hundreds of stars) is excluded and piles on the edge, so
    // the All pool keeps the same axis as Ranked instead of collapsing to
    // the percentile the moment one aspire map enters the cloud.
    let lim = cap;
    for (let i = srs.length - 1; i >= 0; i--) {
      if (srs[i] <= cap * 3) {
        lim = srs[i];
        break;
      }
    }
    return Math.max(1, Math.ceil(lim * 2) / 2);
  }, [pts]);
  // the visible domain: the zoom rectangle, or the full extent
  const dx0 = zoom?.x0 ?? 0;
  const dx1 = zoom?.x1 ?? xMax;
  const da0 = zoom?.a0 ?? ACC_FLOOR;
  const da1 = zoom?.a1 ?? 1;
  // latest view for the native wheel listener (attached once, reads through)
  const viewRef = useRef({ dx0, dx1, da0, da1, xMax, width });
  viewRef.current = { dx0, dx1, da0, da1, xMax, width };
  const x = (sr: number) =>
    L + ((Math.min(sr, dx1) - dx0) / (dx1 - dx0)) * (width - L - RGT);
  const y = (acc: number) =>
    T + (1 - (Math.max(acc, da0) - da0) / (da1 - da0)) * (H - T - B);
  // unzoomed, outliers pile on the edges (right edge / floor line) so every
  // map stays visible; zoomed, whatever lies outside the window is dropped
  const inView = (p: ScatterPoint) =>
    zoom == null ||
    (p[1] >= dx0 && p[1] <= dx1 && p[2] >= da0 && p[2] <= da1);

  // The element's real width, kept in sync so the canvas never upscales.
  // `ready` matters: the first mount renders the skeleton (no canvas), so an
  // effect run only once would observe nothing and the canvas would stay on
  // its default width forever, CSS-stretched into fat blurry dots until the
  // tab was left and reopened. Re-run when the canvas actually exists.
  const ready = data != null;
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure(); // no blurry first frame while the observer warms up
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Wheel = zoom on the cursor. A NATIVE non-passive listener: React's
    // onWheel cannot preventDefault (passive), and the page must not scroll
    // while zooming the cloud.
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const rect = el.getBoundingClientRect();
      const fx = clamp((e.clientX - rect.left - L) / (v.width - L - RGT), 0, 1);
      const fy = clamp((((e.clientY - rect.top) / rect.height) * H - T) / (H - T - B), 0, 1);
      const cx = v.dx0 + fx * (v.dx1 - v.dx0);
      const cy = v.da1 - fy * (v.da1 - v.da0);
      const k = e.deltaY < 0 ? 0.8 : 1.25;
      let spanX = (v.dx1 - v.dx0) * k;
      let spanA = (v.da1 - v.da0) * k;
      // zoomed all the way back out: return to the plain full view
      if (spanX >= v.xMax && spanA >= 1 - ACC_FLOOR) return setZoom(null);
      spanX = clamp(spanX, 0.05, v.xMax);
      spanA = clamp(spanA, 0.002, 1 - ACC_FLOOR);
      const x0 = clamp(cx - fx * spanX, 0, v.xMax - spanX);
      const a1 = clamp(cy + fy * spanA, ACC_FLOOR + spanA, 1);
      setZoom({ x0, x1: x0 + spanX, a0: a1 - spanA, a1 });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [ready]);

  // spatial index for the hover lookup, in logical px
  const grid = useMemo(() => {
    const g = new Map<number, number[]>();
    pts.forEach((p, i) => {
      if (!inView(p)) return;
      const k = Math.floor(x(p[1]) / 12) * 10000 + Math.floor(y(p[2]) / 12);
      const arr = g.get(k);
      if (arr) arr.push(i);
      else g.set(k, [i]);
    });
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, xMax, width, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // everything is drawn IN DEVICE PIXELS, snapped to the grid: a logical
    // transform put the dots between physical pixels (blur on any fractional
    // devicePixelRatio, i.e. every Windows scaling setting)
    const px = (v: number) => Math.round(v * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${Math.round(10 * dpr)}px system-ui`;
    ctx.fillStyle = "#9d94b3";
    ctx.strokeStyle = "#362d48";
    ctx.lineWidth = 1;
    // gridline steps sized to the visible span, so the axes stay readable
    // whatever the domain (a loved pool reaches hundreds of stars)
    const aStep = niceStep(da1 - da0, 9, 0.005);
    for (let a = Math.ceil(da0 / aStep) * aStep; a <= da1 + 1e-9; a += aStep) {
      const yy = px(y(a)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px(L), yy);
      ctx.lineTo(px(width - RGT), yy);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(`${+(a * 100).toFixed(2)}%`, px(L - 5), px(y(a)) + 3 * dpr);
    }
    const sStep = niceStep(dx1 - dx0, 12, 0.1);
    for (let s = Math.max(sStep, Math.ceil(dx0 / sStep) * sStep); s <= dx1 + 1e-9; s += sStep) {
      const xx = px(x(s)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(xx, px(T));
      ctx.lineTo(xx, px(H - B));
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(`${+s.toFixed(2)}★`, px(x(s)), px(H - 10));
    }
    // dots, translucent so the density reads as shading
    const d = Math.max(2, Math.round(1.1 * dpr) * 2);
    ctx.globalAlpha = 0.5;
    for (const p of pts) {
      if (isHidden(p) || !inView(p)) continue;
      ctx.fillStyle =
        mode === "grades" ? GRADE_COLORS[p[4]] ?? "#ff66aa" : FC_KEYS[keyOf(p)].color;
      ctx.fillRect(px(x(p[1])) - d / 2, px(y(p[2])) - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
  }, [pts, hidden, mode, xMax, width, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  /** mouse position in logical px (the canvas CSS box) */
  const mouseXY = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      mx: e.clientX - rect.left,
      my: ((e.clientY - rect.top) / rect.height) * H,
    };
  };
  /** logical px back to data coordinates, within the current domain */
  const invX = (v: number) => dx0 + ((v - L) / (width - L - RGT)) * (dx1 - dx0);
  const invY = (v: number) => da0 + (1 - (v - T) / (H - T - B)) * (da1 - da0);

  /** every visible point within HOVER_R of the mouse, nearest first */
  const findAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { mx, my } = mouseXY(e);
    const found: { i: number; d: number }[] = [];
    const span = Math.ceil(HOVER_R / 12);
    for (let gx = -span; gx <= span; gx++)
      for (let gy = -span; gy <= span; gy++) {
        const k =
          (Math.floor(mx / 12) + gx) * 10000 + (Math.floor(my / 12) + gy);
        for (const i of grid.get(k) ?? []) {
          const p = pts[i];
          if (isHidden(p)) continue;
          const d = (x(p[1]) - mx) ** 2 + (y(p[2]) - my) ** 2;
          if (d <= HOVER_R * HOVER_R) found.push({ i, d });
        }
      }
    return found.sort((a, b) => a.d - b.d).map((f) => f.i);
  };

  // names of the hovered maps, cached forever (they do not change)
  const tipIds = tip?.ids ?? [];
  const { data: names } = useQuery({
    queryKey: ["map-names", tipIds.join(",")],
    queryFn: () => fetchMapNames(tipIds),
    enabled: tipIds.length > 0,
    staleTime: Infinity,
  });

  if (!data) return <PanelSkeleton lines={8} />;
  const legend =
    mode === "grades"
      ? GRADE_ORDER.map((g, revIdx) => {
          const k = 7 - revIdx; // GRADE_ORDER is XH..D, keys are D..XH
          return {
            k,
            label: g === "XH" ? "SSH" : g === "X" ? "SS" : g,
            color: GRADE_COLORS[k],
            count: pts.filter((p) => p[4] === k).length,
          };
        })
      : FC_KEYS.map((f, k) => ({
          k,
          label: f.label,
          color: f.color,
          count: pts.filter((p) => f.match(p[3])).length,
        }));
  const byId = new Map(pts.map((p) => [p[0], p]));
  return (
    <div className="panel scatter-panel">
      <div className="scatter-head">
        <h3>Accuracy by difficulty</h3>
        <span className="scatter-sub">
          my best on each of the {fmtNum(pts.length)} maps played
          {at ? ` · as of ${at.replaceAll("-", "/")}` : ""} · drag to zoom
        </span>
        <div className="seg scatter-mode">
          <button
            className={mode === "grades" ? "active" : ""}
            onClick={() => {
              setMode("grades");
              setHidden(new Set());
            }}
          >
            Grades
          </button>
          <button
            className={mode === "fc" ? "active" : ""}
            onClick={() => {
              setMode("fc");
              setHidden(new Set());
            }}
          >
            FC
          </button>
        </div>
        <button
          className="scatter-reset"
          // the slot is reserved (visibility, not unmount): appearing and
          // vanishing used to shove the legend sideways on every zoom
          style={{ visibility: zoom != null ? "visible" : "hidden" }}
          onClick={() => setZoom(null)}
        >
          Reset zoom
        </button>
        <div className="scatter-legend">
          {legend.map((l) => (
            <button
              key={l.k}
              className={`scatter-key${hidden.has(l.k) ? " off" : ""}`}
              title="Click to show / hide"
              onClick={() =>
                setHidden((h) => {
                  const n = new Set(h);
                  if (n.has(l.k)) n.delete(l.k);
                  else n.add(l.k);
                  return n;
                })
              }
            >
              <span className="gauge-dot" style={{ background: l.color }} />
              {l.label} <i>{fmtNum(l.count)}</i>
            </button>
          ))}
        </div>
      </div>
      <div className="scatter-wrap">
        <canvas
          ref={canvasRef}
          className="scatter-canvas"
          style={{ height: H }}
          title="Drag a rectangle to zoom · wheel: zoom on the cursor · middle drag: pan"
          onMouseDown={(e) => {
            const { mx, my } = mouseXY(e);
            if (e.button === 1) {
              // middle button: grab the view and pan it. Only when zoomed:
              // panning the full view would turn it into an explicit zoom of
              // the same domain, which DROPS the edge-piled outliers (the
              // full view clamps them onto the edges, a zoom clips them)
              e.preventDefault();
              if (zoom == null) return;
              panRef.current = { sx: mx, sy: my, z: { x0: dx0, x1: dx1, a0: da0, a1: da1 } };
              return;
            }
            if (e.button !== 0) return;
            dragRef.current = { sx: mx, sy: my, zoomed: false };
          }}
          onMouseMove={(e) => {
            const { mx, my } = mouseXY(e);
            const pan = panRef.current;
            if (pan) {
              setTip(null);
              const z = pan.z;
              const spanX = z.x1 - z.x0;
              const spanA = z.a1 - z.a0;
              // pixel delta converted to data units, clamped to the extent
              const ddx = ((pan.sx - mx) / (width - L - RGT)) * spanX;
              const dda = ((my - pan.sy) / (H - T - B)) * spanA;
              const x0 = Math.min(Math.max(0, z.x0 + ddx), xMax - spanX);
              const a0 = Math.min(Math.max(ACC_FLOOR, z.a0 + dda), 1 - spanA);
              setZoom({ x0, x1: x0 + spanX, a0, a1: a0 + spanA });
              return;
            }
            const drag = dragRef.current;
            if (drag && (Math.abs(mx - drag.sx) > 4 || Math.abs(my - drag.sy) > 4)) {
              setTip(null);
              setDragBox({
                x: Math.min(mx, drag.sx),
                y: Math.min(my, drag.sy),
                w: Math.abs(mx - drag.sx),
                h: Math.abs(my - drag.sy),
              });
              return;
            }
            const found = findAt(e);
            if (found.length === 0) return setTip(null);
            const first = pts[found[0]];
            setTip({
              fx: x(first[1]) / width,
              fy: y(first[2]) / H,
              ids: found.slice(0, 12).map((i) => pts[i][0]),
              extra: Math.max(0, found.length - 12),
            });
          }}
          onMouseUp={(e) => {
            if (e.button === 1) {
              panRef.current = null;
              return;
            }
            const drag = dragRef.current;
            dragRef.current = null;
            setDragBox(null);
            if (!drag) return;
            const { mx, my } = mouseXY(e);
            if (Math.abs(mx - drag.sx) < 8 || Math.abs(my - drag.sy) < 8) return;
            // clamp to the CURRENT domain: a drag started over the axis
            // gutter must not zoom below it (or under the accuracy floor)
            const nx0 = Math.max(dx0, invX(Math.min(mx, drag.sx)));
            const nx1 = Math.min(dx1, invX(Math.max(mx, drag.sx)));
            const na0 = Math.max(da0, invY(Math.max(my, drag.sy)));
            const na1 = Math.min(1, invY(Math.min(my, drag.sy)));
            // a sliver of a rectangle would zoom into nothing
            if (nx1 - nx0 < 0.05 || na1 - na0 < 0.002) return;
            setZoom({ x0: nx0, x1: nx1, a0: na0, a1: na1 });
            // swallow the click this mouseup fires, it is not a map open
            drag.zoomed = true;
            dragRef.current = drag;
            setTimeout(() => (dragRef.current = null), 0);
          }}
          onMouseLeave={() => {
            setTip(null);
            setDragBox(null);
            dragRef.current = null;
            panRef.current = null;
          }}
          onAuxClick={(e) => e.preventDefault()}
          onClick={(e) => {
            if (dragRef.current?.zoomed) return;
            const found = findAt(e);
            if (found.length > 0) setModalId(pts[found[0]][0]);
          }}
        />
        {dragBox && (
          <div
            className="scatter-zoombox"
            style={{ left: dragBox.x, top: dragBox.y, width: dragBox.w, height: dragBox.h }}
          />
        )}
        {tip && (
          <div
            className="curve-tip scatter-tip"
            style={{
              left: `${Math.min(80, Math.max(20, tip.fx * 100))}%`,
              top: `${tip.fy * 100}%`,
              transform: `translate(-50%, ${tip.fy > 0.5 ? "-108%" : "10%"})`,
            }}
          >
            {tip.ids.map((id) => {
              const p = byId.get(id);
              if (!p) return null;
              return (
                <div key={id} className="scatter-tip-row">
                  <span
                    className="gauge-dot"
                    style={{
                      background:
                        mode === "grades"
                          ? GRADE_COLORS[p[4]]
                          : FC_KEYS[p[3] <= 1 ? 0 : 1].color,
                    }}
                  />
                  <span className="scatter-tip-name">
                    {names?.names[id] ?? "…"}
                  </span>
                  <i>
                    {p[1].toFixed(2)}★ · {(p[2] * 100).toFixed(2)}%
                  </i>
                </div>
              );
            })}
            {tip.extra > 0 && (
              <div className="scatter-tip-more">+{fmtNum(tip.extra)} more · click opens the nearest</div>
            )}
          </div>
        )}
      </div>
      {modalId != null && (
        <MapModal beatmapId={modalId} ruleset={ruleset} onClose={() => setModalId(null)} />
      )}
    </div>
  );
});
