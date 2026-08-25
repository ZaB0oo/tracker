import { getState, setState } from "./db/db.js";

/** Display flags for optional features (UI-only, no data impact). */
export interface DisplayPrefs {
  wither: boolean;
  /** Performance tile counts locally estimated pp (unranked mod combos).
   * On by default; off shows the official-pp-only figure. */
  estPerf: boolean;
}

export function getDisplayPrefs(): DisplayPrefs {
  return {
    wither: getState("show_wither") === "1",
    estPerf: getState("est_perf") !== "0",
  };
}

export function setDisplayPrefs(prefs: Partial<DisplayPrefs>): void {
  if (prefs.wither != null) setState("show_wither", prefs.wither ? "1" : "0");
  if (prefs.estPerf != null) setState("est_perf", prefs.estPerf ? "1" : "0");
}
