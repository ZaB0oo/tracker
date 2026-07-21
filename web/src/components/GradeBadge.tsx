/**
 * Official osu! grade badges (GradeSmall assets, 32x16). Loaded as raw SVG and
 * exposed as data URLs so they can be embedded both in the DOM (<img>) and
 * inside the share-card SVG (<image href>), which survives the PNG export.
 */
import xh from "../assets/grades/xh.svg?raw";
import x from "../assets/grades/x.svg?raw";
import sh from "../assets/grades/sh.svg?raw";
import s from "../assets/grades/s.svg?raw";
import a from "../assets/grades/a.svg?raw";
import b from "../assets/grades/b.svg?raw";
import c from "../assets/grades/c.svg?raw";
import d from "../assets/grades/d.svg?raw";

const RAW: Record<string, string> = { XH: xh, X: x, SH: sh, S: s, A: a, B: b, C: c, D: d };

const URLS: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [
    k,
    `data:image/svg+xml;utf8,${encodeURIComponent(v)}`,
  ])
);

/** Data URL of a grade badge (32x16 aspect), or null for unknown grades. */
export function gradeDataUrl(grade: string | null | undefined): string | null {
  return grade ? URLS[grade] ?? null : null;
}

/** Standalone badge for HTML contexts (maps table, dashboard, history…). */
export function GradeBadge({
  grade,
  width = 34,
  title,
}: {
  grade: string | null | undefined;
  width?: number;
  title?: string;
}) {
  const url = gradeDataUrl(grade);
  if (!url) return <>—</>;
  return (
    <img
      className="grade-badge"
      src={url}
      width={width}
      height={width / 2}
      alt={title ?? grade ?? ""}
      title={title}
    />
  );
}
