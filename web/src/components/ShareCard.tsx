import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus } from "../api";
import { firstPlaceLabel } from "../country";
import type { Stats } from "../types";

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Shareable profile card: an SVG snapshot of the hero stats, downloadable as a
 * PNG (SVG serialized onto a canvas at 2x — no external assets, so the canvas
 * stays untainted).
 */
export function ShareCard({
  stats,
  country,
  onClose,
}: {
  stats: Stats;
  country: string | null;
  onClose: () => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { data: auth } = useQuery({ queryKey: ["auth"], queryFn: fetchAuthStatus });
  const username = auth?.profile?.username ?? "osu! player";

  const t = stats.totals;
  const played = t.played ?? 0;
  const pct = t.total > 0 ? ((played / t.total) * 100).toFixed(1) : "0";
  const grades = new Map<string, number>(
    stats.grades.map((gr) => [gr.grade, gr.c])
  );
  const g = (k: string): number => grades.get(k) ?? 0;
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "/");

  const download = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 840;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 1600, 840);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `osu-completionist-${date.replaceAll("/", "-")}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    };
    img.src = url;
  };

  const gradePills: { label: string; count: number; color: string }[] = [
    { label: "SSH", count: g("XH"), color: "#e0e0e8" },
    { label: "SS", count: g("X"), color: "#ffd966" },
    { label: "SH", count: g("SH"), color: "#e0e0e8" },
    { label: "S", count: g("S"), color: "#ffd966" },
    { label: "A", count: g("A"), color: "#7be87b" },
  ];

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal">
        <div className="adv-head">
          <h2>Share card</h2>
          <button className="mm-close" onClick={onClose}>✕</button>
        </div>
        <div className="share-preview">
          <svg
            ref={svgRef}
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 800 420"
            width={800}
            height={420}
            fontFamily="'Segoe UI', system-ui, sans-serif"
          >
            <defs>
              <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#1c1626" />
                <stop offset="1" stopColor="#241a33" />
              </linearGradient>
            </defs>
            <rect width="800" height="420" rx="16" fill="url(#bg)" />
            <rect width="800" height="420" rx="16" fill="none" stroke="#362d48" strokeWidth="2" />

            {/* header */}
            <text x="40" y="58" fontSize="26" fontWeight="700" fill="#e8e3f2">
              osu!<tspan fill="#ff66aa">completionist</tspan>
            </text>
            <text x="760" y="58" fontSize="18" fill="#9d94b3" textAnchor="end">
              {username} · {date}
            </text>
            <line x1="40" y1="78" x2="760" y2="78" stroke="#362d48" strokeWidth="2" />

            {/* big stats */}
            <text x="40" y="130" fontSize="16" fill="#9d94b3">CLEARS</text>
            <text x="40" y="172" fontSize="34" fontWeight="700" fill="#e8e3f2">
              {fmt(played)}
              <tspan fontSize="18" fill="#9d94b3"> / {fmt(t.total)} ({pct}%)</tspan>
            </text>

            <text x="420" y="130" fontSize="16" fill="#9d94b3">
              {firstPlaceLabel(country).toUpperCase()}
            </text>
            <text x="420" y="172" fontSize="34" fontWeight="700" fill="#ffd966">
              {fmt(t.country_firsts ?? 0)}
            </text>

            <text x="590" y="130" fontSize="16" fill="#9d94b3">FULL COMBOS</text>
            <text x="590" y="172" fontSize="34" fontWeight="700" fill="#7be87b">
              {fmt(t.fc ?? 0)}
            </text>

            <text x="40" y="230" fontSize="16" fill="#9d94b3">RANKED SCORE (CLASSIC)</text>
            <text x="40" y="272" fontSize="34" fontWeight="700" fill="#66ccff">
              {fmt(stats.scoreSums.classic)}
            </text>

            {/* grade pills */}
            {gradePills.map((p, i) => (
              <g key={p.label} transform={`translate(${40 + i * 146}, 310)`}>
                <rect width="130" height="56" rx="10" fill="#2a2338" />
                <text x="14" y="36" fontSize="22" fontWeight="700" fill={p.color}>
                  {p.label}
                </text>
                <text x="116" y="36" fontSize="20" fill="#e8e3f2" textAnchor="end">
                  {fmt(p.count)}
                </text>
              </g>
            ))}

            <text x="760" y="400" fontSize="13" fill="#9d94b3" textAnchor="end">
              github.com/ZaB0oo/tracker
            </text>
          </svg>
        </div>
        <div className="adv-actions">
          <button className="primary" onClick={download}>Download PNG</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
