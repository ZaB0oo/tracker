import { useState } from "react";

/**
 * Small "Customize" popover with a checkbox per item, to pick which sections
 * of a view are shown. Visibility state is managed by the parent (useHidden).
 */
export function VisibilityMenu({
  items,
  isHidden,
  onToggle,
  label = "Customize",
}: {
  items: { id: string; label: string }[];
  isHidden: (id: string) => boolean;
  onToggle: (id: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="vis-wrap">
      <button className="vis-btn" onClick={() => setOpen((o) => !o)}>
        ⚙ {label}
      </button>
      {open && (
        <>
          <div className="menu-overlay" onClick={() => setOpen(false)} />
          <div className="vis-menu">
            {items.map((it) => (
              <label key={it.id}>
                <input
                  type="checkbox"
                  checked={!isHidden(it.id)}
                  onChange={() => onToggle(it.id)}
                />
                {it.label}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
