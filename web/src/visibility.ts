import { useCallback, useMemo, useState } from "react";

/**
 * Per-view "which items to show" preference, persisted in localStorage.
 * Items are hidden by id; anything not in the hidden set is shown.
 *
 * `isHidden` and `toggle` keep a STABLE identity across renders: they are
 * passed to memoized panels, and fresh closures on every render defeated
 * those memos — every dashboard bar re-rendered on each time-machine tick.
 */
export function useHidden(key: string, defaultHidden: string[] = []) {
  const storeKey = `hidden:${key}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(storeKey);
      return new Set(stored ? JSON.parse(stored) : defaultHidden);
    } catch {
      return new Set(defaultHidden);
    }
  });
  const toggle = useCallback(
    (id: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        localStorage.setItem(storeKey, JSON.stringify([...next]));
        return next;
      });
    },
    [storeKey]
  );
  // new identity only when the SET changes, not on every render
  const isHidden = useMemo(() => (id: string) => hidden.has(id), [hidden]);
  return useMemo(() => ({ isHidden, toggle }), [isHidden, toggle]);
}
