import { getState, setState } from "./db/db.js";

/** Display flags for optional features (UI-only, no data impact). */
export interface DisplayPrefs {
  wither: boolean;
}

export function getDisplayPrefs(): DisplayPrefs {
  return {
    wither: getState("show_wither") === "1",
  };
}

export function setDisplayPrefs(prefs: Partial<DisplayPrefs>): void {
  if (prefs.wither != null) setState("show_wither", prefs.wither ? "1" : "0");
}
