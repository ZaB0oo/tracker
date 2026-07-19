import { useQuery } from "@tanstack/react-query";
import { fetchSettings, type DisplayPrefs } from "./api";

const DEFAULTS: DisplayPrefs = { wither: false };

/**
 * Optional-feature display flags (witherscore). Off by default; toggled in
 * Advanced settings. Used to show/hide personal UI.
 */
export function useDisplayPrefs(): DisplayPrefs {
  const { data } = useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
  return data?.display ?? DEFAULTS;
}
