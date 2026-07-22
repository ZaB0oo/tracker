// Shared formatting helpers. Numbers use en-US grouping; dates are yyyy/mm/dd.

export const fmtNum = (n: number): string => n.toLocaleString("en-US");

/** Compact display for huge values: 1.23B / 4.5M, full grouping below 1M. */
export const fmtCompact = (n: number): string =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}M`
      : fmtNum(n);

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
