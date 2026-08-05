import { useState } from "react";

/**
 * Per-view "which items to show" preference, persisted in localStorage.
 * Items are hidden by id; anything not in the hidden set is shown.
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
  const toggle = (id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem(storeKey, JSON.stringify([...next]));
      return next;
    });
  };
  return { isHidden: (id: string) => hidden.has(id), toggle };
}
