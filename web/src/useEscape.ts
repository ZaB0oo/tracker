import { useEffect, useRef } from "react";

/**
 * Closes a modal on Escape. Shared by every modal so the behaviour is
 * identical everywhere (clicking the overlay already closed them, the
 * keyboard did not).
 *
 * Modals stack (a pack modal opens a map modal), so a plain window listener
 * per modal would close them all at once: handlers on the same target all
 * fire, in registration order. Hence one shared listener over a stack — only
 * the top-most (last mounted) handler runs.
 *
 * The stack holds a STABLE token per mount, not the callback: call sites pass
 * an inline arrow, so a parent re-render would otherwise re-register the
 * handler and push a child modal underneath its own parent.
 */
interface Entry {
  fn: () => void;
}
const stack: Entry[] = [];

if (typeof window !== "undefined")
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || stack.length === 0) return;
    // let the focused field handle its own Escape (IME composition, native
    // date picker) and never discard a form the user is typing in
    if (e.defaultPrevented || e.isComposing) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable)
      return;
    stack[stack.length - 1].fn();
  });

export function useEscape(onClose: () => void, enabled = true): void {
  // the entry identity is per mount; only its payload follows re-renders
  const entry = useRef<Entry>({ fn: onClose });
  entry.current.fn = onClose;
  useEffect(() => {
    if (!enabled) return;
    const e = entry.current;
    stack.push(e);
    return () => {
      const i = stack.lastIndexOf(e);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}
