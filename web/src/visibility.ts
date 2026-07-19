import { useState } from "react";

/**
 * Per-view "which items to show" preference, persisted in localStorage.
 * Items are hidden by id; anything not in the hidden set is shown.
 */
export function useHidden(key: string) {
  const storeKey = `hidden:${key}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storeKey) ?? "[]"));
    } catch {
      return new Set();
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
