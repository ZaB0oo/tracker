import { useCallback, useMemo, useState } from "react";

/**
 * Per-view "which items to show" preference, persisted in localStorage.
 * Items are hidden by id; anything not in the hidden set is shown.
 *
 * `isHidden` and `toggle` keep a STABLE identity across renders: they are
 * passed to memoized panels, and fresh closures on every render defeated
 * those memos — every dashboard bar re-rendered on each time-machine tick.
 */
export function useHidden(key: string, defaultHidden: string[] = [], knownIds?: string[]) {
  const storeKey = `hidden:${key}`;
  const knownKey = `hidden-known:${key}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(storeKey);
      const set = new Set<string>(stored ? JSON.parse(stored) : defaultHidden);
      // An id added by an update is absent from a stored preference, which
      // would surface it for everyone: hide the newcomers that default to
      // hidden, and remember which ids have been offered.
      if (stored && knownIds) {
        const seen = new Set<string>(
          JSON.parse(localStorage.getItem(knownKey) ?? "[]")
        );
        for (const id of defaultHidden) if (!seen.has(id)) set.add(id);
        localStorage.setItem(storeKey, JSON.stringify([...set]));
      }
      if (knownIds) localStorage.setItem(knownKey, JSON.stringify(knownIds));
      return set;
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
