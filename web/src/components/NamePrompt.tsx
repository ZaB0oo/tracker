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
}: {
  title: string;
  initial: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  useEscape(onClose); // Esc closes the top-most modal
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const confirm = () => {
    const v = value.trim();
    if (!v) return;
    onClose();
    onSubmit(v);
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
