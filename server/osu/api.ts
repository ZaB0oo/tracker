import { config } from "../config.js";
import { getState, setState } from "../db/db.js";
import { RateLimiter, RetryableError, type Priority } from "./rateLimiter.js";
import type {
  ApiBeatmap,
  BeatmapsetSearchResponse,
  SoloScore,
} from "./types.js";

function initialRpm(): number {
  try {
    const v = Number(getState("api_rpm"));
    if (Number.isFinite(v) && v >= 1 && v <= 60) return v;
  } catch {
    /* DB not ready yet */
  }
  return config.apiRpm;
}

export const limiter = new RateLimiter(initialRpm());

export function getCurrentRpm(): number {
  return Math.round(60_000 / limiter.minIntervalMs);
}

export function applyApiRpm(rpm: number): void {
  limiter.setRpm(rpm);
}

/** Call after an OAuth client change: forgets all tokens. */
export function resetAuthTokens(): void {
  token = null;
  userToken = null;
}

/**
 * fetch that converts NETWORK failures (DNS, dropped connection: "fetch
 * failed") into a RetryableError with the URL: the rate limiter retries with
 * backoff instead of failing outright, and the logged error says on what.
 */
async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new RetryableError(`network: ${msg} — ${url}`);
  }
}

let token: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  const res = await netFetch(config.oauthTokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": config.userAgent,
    },
    body: JSON.stringify({
      client_id: config.osuClientId,
      client_secret: config.osuClientSecret,
      grant_type: "client_credentials",
      scope: "public",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status >= 500 || res.status === 429)
      throw new RetryableError(`oauth ${res.status}: ${body}`);
    throw new Error(
      `OAuth failed (${res.status}) — check OSU_CLIENT_ID/OSU_CLIENT_SECRET in .env: ${body}`
    );
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  token = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return token.value;
}

export class NotFoundError extends Error {}

// ---------- User OAuth (authorization code) ----------
// Required ONLY for country leaderboards (type=country), which require a
// connected osu!supporter account. Everything else keeps client credentials.

let userToken: { value: string; expiresAt: number } | null = null;

export function getAuthorizeUrl(): string {
  const p = new URLSearchParams({
    client_id: config.osuClientId,
    redirect_uri: config.authRedirectUri,
    response_type: "code",
    scope: "public identify",
  });
  return `https://osu.ppy.sh/oauth/authorize?${p.toString()}`;
}

export function isUserConnected(): boolean {
  return Boolean(getState("user_refresh_token"));
}

async function userTokenRequest(body: Record<string, string>): Promise<void> {
  const res = await netFetch(config.oauthTokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": config.userAgent,
    },
    body: JSON.stringify({
      client_id: config.osuClientId,
      client_secret: config.osuClientSecret,
      ...body,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 401) setState("user_refresh_token", "");
    throw new Error(`User OAuth (${res.status}): ${txt}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  userToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  setState("user_refresh_token", json.refresh_token);
}

export async function exchangeAuthCode(code: string): Promise<void> {
  await userTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.authRedirectUri,
  });
}

async function getUserToken(): Promise<string> {
  if (userToken && Date.now() < userToken.expiresAt - 60_000)
    return userToken.value;
  const refresh = getState("user_refresh_token");
  if (!refresh)
    throw new Error(
      `osu! account not connected: open http://localhost:${config.port}/api/auth/login`
    );
  await userTokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
  return userToken!.value;
}

/** osu! profile stats used by the share card (subset of GET /me statistics). */
export interface ProfileStats {
  play_count: number;
  play_time: number; // seconds
  total_hits: number;
  level: number;
  medals: number;
  global_rank: number | null;
  country_rank: number | null;
  pp: number;
  accuracy: number; // hit accuracy in percent
  ranked_score: number;
  total_score: number;
  followers: number;
  join_date: string; // ISO
  supporter: boolean;
}

/** Connected account profile (username, avatar, country, stats), via GET /me. */
export async function fetchUserProfile(): Promise<{
  username: string;
  avatar_url: string;
  cover_url: string;
  country_code: string;
  stats: ProfileStats;
} | null> {
  return limiter.schedule(async () => {
    const auth = await getUserToken();
    const res = await netFetch(`${config.apiBase}/me`, {
      headers: {
        Authorization: `Bearer ${auth}`,
        Accept: "application/json",
        "User-Agent": config.userAgent,
      },
    });
    if (!res.ok) throw new Error(`GET /me: HTTP ${res.status}`);
    const j = (await res.json()) as {
      username: string;
      avatar_url: string;
      cover_url?: string;
      cover?: { url?: string; custom_url?: string };
      country_code?: string;
      country?: { code?: string };
      statistics?: {
        play_count?: number;
        play_time?: number;
        total_hits?: number;
        level?: { current?: number };
        global_rank?: number | null;
        country_rank?: number | null;
        pp?: number;
        hit_accuracy?: number;
        ranked_score?: number;
        total_score?: number;
      };
      user_achievements?: unknown[];
      follower_count?: number;
      join_date?: string;
      is_supporter?: boolean;
    };
    return {
      username: j.username,
      avatar_url: j.avatar_url,
      cover_url: j.cover_url ?? j.cover?.custom_url ?? j.cover?.url ?? "",
      country_code: j.country_code ?? j.country?.code ?? "",
      stats: {
        play_count: j.statistics?.play_count ?? 0,
        play_time: j.statistics?.play_time ?? 0,
        total_hits: j.statistics?.total_hits ?? 0,
        level: j.statistics?.level?.current ?? 0,
        medals: j.user_achievements?.length ?? 0,
        global_rank: j.statistics?.global_rank ?? null,
        country_rank: j.statistics?.country_rank ?? null,
        pp: j.statistics?.pp ?? 0,
        accuracy: j.statistics?.hit_accuracy ?? 0,
        ranked_score: j.statistics?.ranked_score ?? 0,
        total_score: j.statistics?.total_score ?? 0,
        followers: j.follower_count ?? 0,
        join_date: j.join_date ?? "",
        supporter: j.is_supporter ?? false,
      },
    };
  }, "high");
}

/** Country code of the connected account, read from the stored profile. */
export function getStoredCountryCode(): string | null {
  const raw = getState("user_profile");
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { country_code?: string }).country_code || null;
  } catch {
    return null;
  }
}

/** Log out of the account: forgets refresh token and profile. */
export function logoutUser(): void {
  userToken = null;
  setState("user_refresh_token", "");
  setState("user_profile", "");
}

/**
 * Top of a map's COUNTRY leaderboard (country of the connected account).
 * Requires osu!supporter. null if the map has no country score.
 */
export async function getCountryTop(
  beatmapId: number,
  priority: Priority = "low"
): Promise<import("./types.js").SoloScore | null> {
  return limiter.schedule(async () => {
    const auth = await getUserToken();
    const res = await netFetch(
      `${config.apiBase}/beatmaps/${beatmapId}/scores?mode=osu&type=country`,
      {
        headers: {
          Authorization: `Bearer ${auth}`,
          Accept: "application/json",
          "User-Agent": config.userAgent,
          "x-api-version": config.apiVersion,
        },
      }
    );
    if (res.status === 404) return null;
    if (res.status === 401) {
      userToken = null;
      throw new RetryableError("401, refreshing user token");
    }
    if (res.status === 403)
      throw new Error(
        "403 on type=country: country leaderboards require an osu!supporter account"
      );
    if (res.status === 429) {
      const ra = res.headers.get("Retry-After");
      throw new RetryableError("429", ra ? Number(ra) * 1000 : undefined);
    }
    if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} on country LB ${beatmapId}`);
    const json = (await res.json()) as {
      scores: import("./types.js").SoloScore[];
    };
    return json.scores[0] ?? null;
  }, priority);
}

/** Authenticated + rate-limited GET. 404 => NotFoundError (map never played, etc.). */
async function apiGet<T>(pathAndQuery: string, priority: Priority): Promise<T> {
  return limiter.schedule(async () => {
    const auth = await getToken();
    const res = await netFetch(`${config.apiBase}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${auth}`,
        Accept: "application/json",
        "User-Agent": config.userAgent,
        "x-api-version": config.apiVersion,
      },
    });
    if (res.status === 404) throw new NotFoundError(pathAndQuery);
    if (res.status === 401) {
      token = null; // expired/revoked token -> retry with a fresh one
      throw new RetryableError("401, refreshing token");
    }
    if (res.status === 429) {
      const ra = res.headers.get("Retry-After");
      throw new RetryableError(
        "429 rate limited",
        ra ? Number(ra) * 1000 : undefined
      );
    }
    if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathAndQuery}`);
    return (await res.json()) as T;
  }, priority);
}

/** All my scores on a diff (top score per mods combo, history included). */
export async function getUserBeatmapScores(
  beatmapId: number,
  userId: number,
  priority: Priority = "low"
): Promise<SoloScore[]> {
  try {
    const res = await apiGet<{ scores: SoloScore[] }>(
      `/beatmaps/${beatmapId}/scores/users/${userId}/all?ruleset=osu`,
      priority
    );
    // beatmap_id missing from the items on this endpoint -> we reinject it
    return res.scores.map((s) => ({ ...s, beatmap_id: beatmapId }));
  } catch (e) {
    if (e instanceof NotFoundError) return [];
    throw e;
  }
}

/** Recent scores (24h window on the API side). */
export async function getRecentScores(
  userId: number,
  limit = 50,
  offset = 0
): Promise<SoloScore[]> {
  return apiGet<SoloScore[]>(
    `/users/${userId}/scores/recent?mode=osu&include_fails=0&limit=${limit}&offset=${offset}`,
    "high"
  );
}

/** Batch beatmap lookup (max 50 ids / request) — used for max_combo/SR enrichment. */
export async function getBeatmapsByIds(
  ids: number[],
  priority: Priority = "low"
): Promise<ApiBeatmap[]> {
  if (ids.length === 0) return [];
  if (ids.length > 50) throw new Error("50 ids max per request");
  const qs = ids.map((id) => `ids[]=${id}`).join("&");
  const res = await apiGet<{ beatmaps: ApiBeatmap[] }>(`/beatmaps?${qs}`, priority);
  return res.beatmaps;
}

/**
 * Direct lookup of a beatmapset by id (with all its diffs).
 * Also works for DMCA sets invisible in the search.
 * null if the set was entirely removed from osu!.
 */
export async function getBeatmapsetById(
  id: number,
  priority: Priority = "low"
): Promise<import("./types.js").ApiBeatmapset | null> {
  try {
    return await apiGet<import("./types.js").ApiBeatmapset>(
      `/beatmapsets/${id}`,
      priority
    );
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/** Paginated beatmapset search (catalog via API). s = "ranked" | "loved". */
export async function searchBeatmapsets(
  category: "ranked" | "loved",
  cursorString: string | null,
  priority: Priority = "low",
  sort: "ranked_asc" | "ranked_desc" = "ranked_asc",
  query?: string,
  mode = 0
): Promise<BeatmapsetSearchResponse> {
  const cursor = cursorString
    ? `&cursor_string=${encodeURIComponent(cursorString)}`
    : "";
  const q = query ? `&q=${encodeURIComponent(query)}` : "";
  return apiGet<BeatmapsetSearchResponse>(
    `/beatmapsets/search?m=${mode}&s=${category}&sort=${sort}&nsfw=true${q}${cursor}`,
    priority
  );
}
