// Shared formatting helpers. Numbers use en-US grouping; dates are yyyy/mm/dd.

export const fmtNum = (n: number): string => n.toLocaleString("en-US");

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
