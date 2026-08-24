// Shared formatting helpers. Numbers use en-US grouping; dates are yyyy/mm/dd.

// null-tolerant: on an empty database SQL SUM() yields NULL for many stats
export const fmtNum = (n: number | null | undefined): string =>
  (n ?? 0).toLocaleString("en-US");

/** Compact display for huge values: 1.23B / 4.5M, full grouping below 1M. */
export const fmtCompact = (n0: number | null | undefined): string => {
  const n = n0 ?? 0;
  return n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`
      : fmtNum(n);
};

/** API rank -> display grade (X/XH are the SS ranks). */
export const displayGrade = (g: string): string =>
  g === "XH" ? "SSH" : g === "X" ? "SS" : g;

/** yyyy/mm/dd from an ISO date string (or "—" when null). */
export const fmtDate = (iso: string | null | undefined): string =>
  iso ? iso.slice(0, 10).replace(/-/g, "/") : "—";

/** yyyy/mm/dd HH:mm from an ISO date string. */
export const fmtDateTime = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
};

/** HH:mm:ss local time. */
export const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** pp with the locally computed fallback (null when neither exists) */
export const effPp = (s: { pp: number | null; pp_local: number | null }) =>
  s.pp ?? (s.pp_local != null && s.pp_local >= 0 ? s.pp_local : null);

/** "226.31pp" official, "~204.87pp" when locally estimated, "" when neither */
export const ppText = (s: { pp: number | null; pp_local: number | null }) => {
  const v = effPp(s);
  return v == null ? "" : `${s.pp == null ? "~" : ""}${v.toFixed(2)}pp`;
};
