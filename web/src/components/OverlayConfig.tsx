import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchMetrics } from "../api";

// Per-section items: hidden entries are encoded as "section.item" in ?hide=
// (a bare "section" hides the whole row).
const GRADE_ITEMS = [
  { id: "xh", label: "SSH" },
  { id: "x", label: "SS" },
  { id: "sh", label: "SH" },
  { id: "s", label: "S" },
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
  { id: "d", label: "D" },
];
const SESSION_ITEMS = [
  { id: "clears", label: "Clears gained" },
  ...GRADE_ITEMS.map((g) => ({ id: g.id, label: `${g.label} gained` })),
  { id: "fc", label: "FCs gained" },
  { id: "country", label: "Country #1 gained" },
  { id: "score", label: "Ranked score gained" },
];
const TOTAL_ITEMS = [
  { id: "clears", label: "Clears (+ completion %)" },
  ...GRADE_ITEMS,
  { id: "fc", label: "FCs" },
  { id: "country", label: "Country #1" },
];

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-section">
      <button className="mb-section-head" onClick={() => setOpen((o) => !o)}>
        <span>{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && <div className="mb-section-body">{children}</div>}
    </div>
  );
}

/**
 * Builds the OBS browser-source URL for the stream overlay. Selection is
 * encoded in the URL (?hide=…&metrics=…) because OBS browser sources don't
 * share localStorage with the app.
 */
export function OverlayConfig({ onClose }: { onClose: () => void }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [metricIds, setMetricIds] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const { data: metricsData } = useQuery({
    queryKey: ["metrics", "month"],
    queryFn: () => fetchMetrics("month"),
  });

  const hideParam = [...hidden].join(",");
  const metricsParam = [...metricIds].join(",");
  // Same origin as the app (works both in dev on :5173 and in prod on :3727).
  const url =
    `${window.location.origin}/?overlay=1` +
    (hideParam ? `&hide=${hideParam}` : "") +
    (metricsParam ? `&metrics=${metricsParam}` : "");

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleMetric = (id: number) =>
    setMetricIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  /** Master checkbox for a whole row (stops click from folding the section). */
  const master = (id: string, label: string) => (
    <label className="mb-check" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={!hidden.has(id)} onChange={() => toggle(id)} />
      {label}
    </label>
  );

  const itemList = (section: string, items: { id: string; label: string }[]) => (
    <div className="ov-items">
      {items.map((it) => (
        <label key={it.id} className="mb-check">
          <input
            type="checkbox"
            disabled={hidden.has(section)}
            checked={!hidden.has(`${section}.${it.id}`)}
            onChange={() => toggle(`${section}.${it.id}`)}
          />
          {it.label}
        </label>
      ))}
    </div>
  );

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

        <Section title={master("session", "Session (live gains since the source loaded)")}>
          {itemList("session", SESSION_ITEMS)}
        </Section>
        <Section title={master("total", "Totals")}>
          {itemList("total", TOTAL_ITEMS)}
        </Section>
        <label className="adv-toggle">
          <input
            type="checkbox"
            checked={!hidden.has("ranked")}
            onChange={() => toggle("ranked")}
          />
          <span>Ranked score</span>
        </label>
        <label className="adv-toggle">
          <input
            type="checkbox"
            checked={!hidden.has("last")}
            onChange={() => toggle("last")}
          />
          <span>Last played map</span>
        </label>

        {(metricsData?.metrics.length ?? 0) > 0 && (
          <Section title="Custom metrics">
            <div className="ov-items">
              {metricsData!.metrics.map((m) => (
                <label key={m.id} className="mb-check">
                  <input
                    type="checkbox"
                    checked={metricIds.has(m.id)}
                    onChange={() => toggleMetric(m.id)}
                  />
                  {m.name}
                </label>
              ))}
            </div>
          </Section>
        )}

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
          <button onClick={() => window.open(url, "osu-overlay", "width=760,height=220")}>
            Open preview
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </>
  );
}
