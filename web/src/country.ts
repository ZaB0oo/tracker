import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus } from "./api";

/**
 * Country code of the connected osu! account (e.g. "FR", "US"), or null when
 * not connected / unknown. Country #1 leaderboards follow the logged-in
 * account's country, so all "#1" labels use this instead of a hardcoded value.
 */
export function useCountryCode(): string | null {
  const { data } = useQuery({ queryKey: ["auth"], queryFn: fetchAuthStatus });
  return data?.profile?.country_code || null;
}

/** "#1 FR" when the country is known, generic "Country #1" otherwise. */
export function firstPlaceLabel(code: string | null): string {
  return code ? `#1 ${code}` : "Country #1";
}
