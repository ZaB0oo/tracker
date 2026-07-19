import { useState } from "react";

const ROWS = [
  { id: "session", label: "Session (live gains since the source loaded)" },
  { id: "total", label: "Total (clears, S, FC, country #1)" },
  { id: "ranked", label: "Ranked score" },
  { id: "last", label: "Last played map" },
];

/**
 * Builds the OBS browser-source URL for the stream overlay. Row selection is
 * encoded in the URL (?hide=…) because OBS browser sources don't share
 * localStorage with the app.
 */
export function OverlayConfig({ onClose }: { onClose: () => void }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  // Same origin as the app (works both in dev on :5173 and in prod on :3727).
  const hideParam = [...hidden].join(",");
  const url = `${window.location.origin}/?overlay=1${
    hideParam ? `&hide=${hideParam}` : ""
  }`;

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal">
        <div className="adv-head">
          <h2>Stream overlay</h2>
          <button className="mm-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="adv-note">
          Pick what to show, then add a Browser source in OBS pointing at this
          URL (transparent background).
        </p>
        {ROWS.map((r) => (
          <label key={r.id} className="adv-toggle">
            <input
              type="checkbox"
              checked={!hidden.has(r.id)}
              onChange={() => toggle(r.id)}
            />
            <span>{r.label}</span>
          </label>
        ))}
        <div className="ov-url">
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
          <button
            className="primary"
            onClick={() => {
              void navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied!" : "Copy URL"}
          </button>
        </div>
        <div className="adv-actions">
          <button onClick={() => window.open(url, "osu-overlay", "width=760,height=190")}>
            Open preview
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
