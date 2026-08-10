import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `osu! API credentials are not set (${name}). Open Settings (menu) and fill in the osu! OAuth section — Client ID, secret and user id. (Source installs can also use a .env file.)`
    );
  }
  return v;
}

// Runtime overrides (UI settings, persisted in DB and applied at boot by
// index.ts). Take priority over .env.
let clientIdOverride: string | null = null;
let clientSecretOverride: string | null = null;
let userIdOverride: number | null = null;

export function applyOAuthOverrides(o: {
  clientId?: string | null;
  clientSecret?: string | null;
  userId?: number | null;
}): void {
  if (o.clientId != null && o.clientId !== "") clientIdOverride = o.clientId;
  if (o.clientSecret != null && o.clientSecret !== "")
    clientSecretOverride = o.clientSecret;
  if (o.userId != null && Number.isFinite(o.userId) && o.userId > 0)
    userIdOverride = o.userId;
}

export const config = {
  get osuClientId(): string {
    return clientIdOverride ?? required("OSU_CLIENT_ID");
  },
  get osuClientSecret(): string {
    return clientSecretOverride ?? required("OSU_CLIENT_SECRET");
  },
  get osuUserId(): number {
    return userIdOverride ?? Number(required("OSU_USER_ID"));
  },
  /** True once client id/secret + user id are available (.env or UI settings). */
  get hasCredentials(): boolean {
    try {
      return Boolean(this.osuClientId && this.osuClientSecret && this.osuUserId);
    } catch {
      return false;
    }
  },
  port: Number(process.env.PORT ?? 3727),
  // Optional: absolute path to LazerCollectionImporter.exe. When set (and the
  // file exists), the UI offers direct import of collections into osu!lazer.
  lazerImporterPath: process.env.LAZER_IMPORTER_PATH ?? null,
  dbPath: path.resolve(process.env.DB_PATH ?? "./data/tracker.db"),
  // Default 50 (max 60, the documented osu! limit): the margin leaves room
  // for the game/website's own traffic on the same IP — running flat out at
  // 60 for long stretches trips Cloudflare's site-wide rate limit (1015).
  apiRpm: 50,
  pollIntervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 120),
  userAgent:
    "osu-completionist-tracker (single-user; https://github.com/osu-completionist-tracker)",
  apiBase: "https://osu.ppy.sh/api/v2",
  oauthTokenUrl: "https://osu.ppy.sh/oauth/token",
  // "solo score" format (lazer + legacy fields in the same response)
  apiVersion: "20220705",
  // User OAuth (country leaderboards) — set this as the Application Callback
  // URL in your osu! OAuth application settings.
  get authRedirectUri() {
    return `http://localhost:${this.port}/api/auth/callback`;
  },
};
