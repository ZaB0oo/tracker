import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus, fetchProfileImages, fetchStats } from "../api";
import { useCountryCode } from "../country";
import { gradeDataUrl } from "./GradeBadge";
import { fmtNum } from "../format";


// Layout constants (SVG units) — mirrors the reference card:
// banner header, then 3 big stats, 5 mid stats, 4 wide stats, 8 grade badges.
const W = 800;
const HEADER_H = 128;
const H = 512;

/**
 * Shareable profile card, styled after the classic osu! stat cards: player
 * banner as header background, rounded avatar, ranks row, profile stats,
 * tracker totals and the official grade badges. Downloaded as PNG (SVG →
 * canvas at 2x; every image is a data URL so the canvas stays clean).
 */
export function ShareCard({ onClose }: { onClose: () => void }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { data: auth } = useQuery({ queryKey: ["auth"], queryFn: fetchAuthStatus });
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: fetchStats });
  const { data: images } = useQuery({
    queryKey: ["profile-images"],
    queryFn: fetchProfileImages,
    staleTime: 10 * 60_000,
  });
  const country = useCountryCode();
  const username = auth?.profile?.username ?? "osu! player";
  const ps = auth?.profile?.stats;

  if (!stats) return null;
  const t = stats.totals;
  const played = t.played ?? 0;
  const grades = new Map<string, number>(stats.grades.map((gr) => [gr.grade, gr.c]));
  const g = (k: string): number => grades.get(k) ?? 0;
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "/");
  const completion = t.total > 0 ? ((played / t.total) * 100).toFixed(2) : "0";

  const joined = ps?.join_date ? new Date(ps.join_date) : null;
  const joinedLabel = joined
    ? joined.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : null;
  const joinedDays = joined
    ? Math.floor((Date.now() - joined.getTime()) / 86_400_000)
    : null;
  const playTime = ps
    ? `${fmtNum(Math.floor(ps.play_time / 3600))}h ${Math.floor((ps.play_time % 3600) / 60)}m`
    : "—";

  const download = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = W * 2;
      canvas.height = H * 2;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, W * 2, H * 2);
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

  // Row definitions (label, value, optional color), following the reference.
  const bigRow = [
    { label: `#1 ${country ?? ""}`.trim(), value: fmtNum(t.country_firsts ?? 0), color: "#ffd966" },
    { label: "Global Rank", value: ps?.global_rank != null ? `#${fmtNum(ps.global_rank)}` : "—", color: "#e8e3f2" },
    { label: "Country Rank", value: ps?.country_rank != null ? `#${fmtNum(ps.country_rank)}` : "—", color: "#b9a8ee" },
  ];
  const midRow = [
    { label: "Medals", value: ps ? fmtNum(ps.medals) : "—" },
    { label: "pp", value: ps ? fmtNum(Math.round(ps.pp)) : "—" },
    { label: "Play Time", value: playTime },
    { label: "Play Count", value: ps ? fmtNum(ps.play_count) : "—" },
    { label: "Accuracy", value: ps ? `${ps.accuracy.toFixed(2)}%` : "—" },
  ];
  const wideRow = [
    { label: "Ranked Score", value: ps ? fmtNum(ps.ranked_score) : "—" },
    { label: "Total Score", value: ps ? fmtNum(ps.total_score) : "—" },
    { label: "Clears", value: fmtNum(played) },
    { label: "Completion", value: `${completion}%` },
  ];
  const gradeRow = ["XH", "X", "SH", "S", "A", "B", "C", "D"];

  const BIG_Y = HEADER_H + 46;
  const MID_Y = BIG_Y + 88;
  const WIDE_Y = MID_Y + 78;
  const GRADES_Y = WIDE_Y + 66;

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal share-modal">
        <div className="adv-head">
          <h2>Share card</h2>
          <button className="mm-close" onClick={onClose}>✕</button>
        </div>

        <div className="share-preview">
          <svg
            ref={svgRef}
            xmlns="http://www.w3.org/2000/svg"
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            fontFamily="'Segoe UI', system-ui, sans-serif"
          >
            <defs>
              <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#1c1626" />
                <stop offset="1" stopColor="#241a33" />
              </linearGradient>
              <linearGradient id="bannerfade" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#17131f" stopOpacity="0.35" />
                <stop offset="0.7" stopColor="#17131f" stopOpacity="0.5" />
                <stop offset="1" stopColor="#1c1626" stopOpacity="1" />
              </linearGradient>
              <linearGradient id="hex" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#66ccff" />
                <stop offset="0.5" stopColor="#b96bf2" />
                <stop offset="1" stopColor="#ff66aa" />
              </linearGradient>
              <clipPath id="cardclip">
                <rect width={W} height={H} rx="18" />
              </clipPath>
              <clipPath id="avatarclip">
                <rect x="26" y="18" width="92" height="92" rx="22" />
              </clipPath>
            </defs>

            <rect width={W} height={H} rx="18" fill="url(#bg)" />
            <g clipPath="url(#cardclip)">
              {images?.cover && (
                <image
                  href={images.cover}
                  x="0"
                  y="0"
                  width={W}
                  height={HEADER_H}
                  preserveAspectRatio="xMidYMid slice"
                />
              )}
              <rect width={W} height={HEADER_H} fill="url(#bannerfade)" />
              {images?.avatar && (
                <image
                  href={images.avatar}
                  x="26"
                  y="18"
                  width="92"
                  height="92"
                  clipPath="url(#avatarclip)"
                  preserveAspectRatio="xMidYMid slice"
                />
              )}
            </g>
            <rect width={W} height={H} rx="18" fill="none" stroke="#362d48" strokeWidth="2" />

            {/* header text block */}
            <rect x="138" y="30" width="6" height="38" rx="3" fill="#ff66aa" />
            <text x="158" y="60" fontSize="32" fontWeight="700" fill="#ffffff">
              {username}
            </text>
            {ps && (
              <>
                <g transform="translate(158, 74)">
                  <rect width="86" height="26" rx="13" fill="#17131f" opacity="0.75" />
                  {/* white follower silhouette */}
                  <g transform="translate(13, 5)" fill="#ffffff">
                    <circle cx="8" cy="5" r="3.4" />
                    <path d="M2 16c0-3.6 2.7-5.8 6-5.8s6 2.2 6 5.8z" />
                  </g>
                  <text x="34" y="18" fontSize="14" fill="#ffffff">
                    {fmtNum(ps.followers)}
                  </text>
                  {ps.supporter && (
                    <>
                      <rect x="94" width="52" height="26" rx="13" fill="#ff66aa" />
                      {/* single supporter heart, sized to the bubble */}
                      <path
                        transform="translate(112, 6) scale(0.62)"
                        fill="#ffffff"
                        d="M12 21.3 3.8 13C1.4 10.5 1.5 6.5 4 4.2c2.3-2.1 5.8-1.8 8 .5 2.2-2.3 5.7-2.6 8-.5 2.5 2.3 2.6 6.3.2 8.8z"
                      />
                    </>
                  )}
                </g>
                {joinedLabel && (
                  <text x="158" y="120" fontSize="15" fill="#e6e0f0">
                    Joined <tspan fontWeight="700">{joinedLabel}</tspan>
                    <tspan fill="#b6adc9"> ({fmtNum(joinedDays ?? 0)}d ago)</tspan>
                  </text>
                )}
              </>
            )}
            {/* country + level, top right */}
            {country && (
              <g transform={`translate(${W - 160}, 30)`}>
                <rect width="52" height="34" rx="8" fill="#17131f" opacity="0.75" />
                <text x="26" y="23" fontSize="16" fontWeight="700" fill="#ffffff" textAnchor="middle">
                  {country}
                </text>
              </g>
            )}
            {ps && (
              <g transform={`translate(${W - 78}, 64)`}>
                {/* rounded corners: fat round-joined dark stroke as the base,
                    then the gradient border drawn with round joins on top */}
                <polygon
                  points="0,-31 27,-15.5 27,15.5 0,31 -27,15.5 -27,-15.5"
                  fill="#17131f"
                  fillOpacity="0.9"
                  stroke="#17131f"
                  strokeOpacity="0.9"
                  strokeWidth="9"
                  strokeLinejoin="round"
                />
                <polygon
                  points="0,-31 27,-15.5 27,15.5 0,31 -27,15.5 -27,-15.5"
                  fill="none"
                  stroke="url(#hex)"
                  strokeWidth="4.5"
                  strokeLinejoin="round"
                />
                <text x="0" y="9" fontSize="26" fontWeight="700" fill="#ffffff" textAnchor="middle">
                  {ps.level}
                </text>
              </g>
            )}

            {/* big ranks row */}
            {bigRow.map((s, i) => {
              const cx = W / 6 + (i * W) / 3;
              return (
                <g key={s.label}>
                  <text x={cx} y={BIG_Y} fontSize="21" fontWeight="700" fill="#cfc8de" textAnchor="middle">
                    {s.label}
                  </text>
                  <text x={cx} y={BIG_Y + 46} fontSize="38" fontWeight="700" fill={s.color} textAnchor="middle">
                    {s.value}
                  </text>
                </g>
              );
            })}

            {/* mid row (5 columns) */}
            {midRow.map((s, i) => {
              const cx = 84 + i * ((W - 168) / 4);
              return (
                <g key={s.label}>
                  <text x={cx} y={MID_Y} fontSize="17" fontWeight="700" fill="#cfc8de" textAnchor="middle">
                    {s.label}
                  </text>
                  <text x={cx} y={MID_Y + 32} fontSize="22" fill="#e8e3f2" textAnchor="middle">
                    {s.value}
                  </text>
                </g>
              );
            })}

            {/* wide row (4 columns) */}
            {wideRow.map((s, i) => {
              const cx = 108 + i * ((W - 216) / 3);
              return (
                <g key={s.label}>
                  <text x={cx} y={WIDE_Y} fontSize="18" fontWeight="700" fill="#cfc8de" textAnchor="middle">
                    {s.label}
                  </text>
                  <text x={cx} y={WIDE_Y + 32} fontSize="21" fill="#e8e3f2" textAnchor="middle">
                    {s.value}
                  </text>
                </g>
              );
            })}

            {/* official grade badges + counts */}
            {gradeRow.map((gr, i) => {
              const cx = 62 + i * ((W - 124) / 7);
              const url = gradeDataUrl(gr);
              return (
                <g key={gr}>
                  {url && (
                    <image href={url} x={cx - 33} y={GRADES_Y} width="66" height="33" />
                  )}
                  <text
                    x={cx}
                    y={GRADES_Y + 56}
                    fontSize="16"
                    fontWeight="700"
                    fill="#ffffff"
                    textAnchor="middle"
                  >
                    {fmtNum(g(gr))}
                  </text>
                </g>
              );
            })}
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
