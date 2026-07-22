import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing environment variable: ${name}. Copy .env.example to .env and fill it in (or configure it in the UI, Settings menu).`
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
  port: Number(process.env.PORT ?? 3727),
  // Optional: absolute path to LazerCollectionImporter.exe. When set (and the
  // file exists), the UI offers direct import of collections into osu!lazer.
  lazerImporterPath: process.env.LAZER_IMPORTER_PATH ?? null,
  dbPath: path.resolve(process.env.DB_PATH ?? "./data/tracker.db"),
  apiRpm: Number(process.env.API_RPM ?? 60),
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
