import { useEffect, useRef, useState } from "react";
import { useEscape } from "../useEscape";

/**
 * In-app replacement for window.prompt (Electron does not implement it):
 * a small centered modal with a text input. Enter confirms, Escape cancels.
 */
export function NamePrompt({
  title,
  initial,
  submitLabel = "OK",
  onSubmit,
  onClose,
  existing,
}: {
  title: string;
  initial: string;
  submitLabel?: string;
  /** `replace` is only ever true when the name matches an existing collection */
  onSubmit: (name: string, replace: boolean) => void;
  onClose: () => void;
  /** lazer import: the collections already there, to pick one instead of
   * retyping its name (and risking a near-miss that creates a duplicate) */
  existing?: { name: string; count: number }[];
}) {
  useEscape(onClose); // Esc closes the top-most modal
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  // The importer matches names byte for byte, so the hit must be exact.
  const hit = existing?.find((c) => c.name === value.trim());
  // Merge is the default even on a hit: it is what the button did until now,
  // and it never loses maps.
  const [replace, setReplace] = useState(false);
  const confirm = () => {
    const v = value.trim();
    if (!v) return;
    onClose();
    onSubmit(v, replace && hit != null);
  };
  return (
    <>
      <div className="menu-overlay modal-overlay" onClick={onClose} />
      <div className="adv-modal name-prompt">
        <div className="adv-head">
          <h2>{title}</h2>
          <button className="mm-close" onClick={onClose}>✕</button>
        </div>
        <input
          ref={input}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirm();
            if (e.key === "Escape") onClose();
          }}
        />
        {existing != null && existing.length > 0 && (
          <div className="np-existing">
            <div className="np-existing-head">Already in lazer — click to target one</div>
            <div className="np-existing-list">
              {existing.map((c) => (
                <button
                  key={c.name}
                  className={`np-existing-item${c.name === value.trim() ? " on" : ""}`}
                  onClick={() => setValue(c.name)}
                  title={`${c.count} map(s)`}
                >
                  {c.name || "(unnamed)"} <span className="tip-dim">{c.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {hit && (
          <div className="np-hit">
            <b>{hit.name}</b> already exists ({hit.count} map(s)).
            <div className="seg np-seg">
              <button className={replace ? "" : "active"} onClick={() => setReplace(false)}>
                Add to it
              </button>
              <button className={replace ? "active" : ""} onClick={() => setReplace(true)}>
                Replace its content
              </button>
            </div>
          </div>
        )}
        <div className="adv-actions">
          <button className="primary" disabled={!value.trim()} onClick={confirm}>
            {submitLabel}
          </button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  );
}
