import { Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOAuthOverrides, config } from "../config.js";
import { getDb, getState, setState } from "../db/db.js";
import {
  applyApiRpm,
  getCurrentRpm,
  logoutUser,
  resetAuthTokens,
} from "../osu/api.js";
import {
  applyPollInterval,
  getCountryRecheckHours,
  getGlobalRecheckHours,
} from "../sync/daemon.js";
import { getDisplayPrefs, setDisplayPrefs } from "../prefs.js";
import {
  getDiscordSettings,
  sendTest,
  setDiscordSettings,
} from "../notify/discord.js";

export const settingsRouter = Router();

// Consistent copy of the DB (VACUUM INTO) downloaded in one click.
settingsRouter.get("/export-db", (_req, res) => {
  const dest = path.join(os.tmpdir(), `tracker-export-${Date.now()}.db`);
  try {
    getDb().exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.download(dest, `tracker-backup-${stamp}.db`, () => {
    fs.unlink(dest, () => undefined);
  });
});

function safe<T>(get: () => T, fallback: T): T {
  try {
    return get();
  } catch {
    return fallback;
  }
}

function getPollSeconds(): number {
  const v = Number(getState("poll_interval_seconds"));
  return Number.isFinite(v) && v >= 10 ? v : config.pollIntervalSeconds;
}

settingsRouter.get("/settings", (_req, res) =>
  res.json({
    apiRpm: getCurrentRpm(),
    pollIntervalSeconds: getPollSeconds(),
    countryRecheckHours: getCountryRecheckHours(),
    globalRecheckHours: getGlobalRecheckHours(),
    display: getDisplayPrefs(),
    discord: getDiscordSettings(),
    // safe accessors: on a first launch without .env the getters throw —
    // the settings UI is precisely where the values get filled in
    oauth: {
      clientId: safe(() => config.osuClientId, ""),
      userId: safe(() => config.osuUserId, 0),
      secretSet: safe(() => Boolean(config.osuClientSecret), false),
    },
    info: { port: config.port },
  })
);

settingsRouter.post("/settings", (req, res) => {
  const body = req.body as {
    apiRpm?: unknown;
    pollIntervalSeconds?: unknown;
    countryRecheckHours?: unknown;
    globalRecheckHours?: unknown;
    display?: { wither?: unknown };
    discord?: { webhookUrl?: unknown; bests?: unknown };
    clientId?: unknown;
    clientSecret?: unknown;
    userId?: unknown;
  };
  if (body.discord != null) {
    const err = setDiscordSettings({
      webhookUrl:
        body.discord.webhookUrl == null ? null : String(body.discord.webhookUrl),
      bests: body.discord.bests == null ? undefined : Boolean(body.discord.bests),
    });
    if (err) return res.status(400).json({ ok: false, error: err });
  }
  if (body.display != null) {
    setDisplayPrefs({
      wither:
        body.display.wither == null ? undefined : Boolean(body.display.wither),
    });
  }
  if (body.countryRecheckHours != null) {
    const h = Number(body.countryRecheckHours);
    if (!Number.isFinite(h) || h < 1 || h > 720)
      return res
        .status(400)
        .json({ ok: false, error: "invalid countryRecheckHours (1..720)" });
    setState("country_recheck_hours", String(Math.round(h)));
  }
  if (body.globalRecheckHours != null) {
    const h = Number(body.globalRecheckHours);
    if (!Number.isFinite(h) || h < 1 || h > 720)
      return res
        .status(400)
        .json({ ok: false, error: "invalid globalRecheckHours (1..720)" });
    setState("global_recheck_hours", String(Math.round(h)));
  }
  if (body.apiRpm != null) {
    const r = Number(body.apiRpm);
    if (!Number.isFinite(r) || r < 1 || r > 60)
      return res
        .status(400)
        .json({ ok: false, error: "invalid apiRpm (1..60, polite osu! limit)" });
    setState("api_rpm", String(Math.round(r)));
    applyApiRpm(Math.round(r));
  }
  if (body.pollIntervalSeconds != null) {
    const p = Number(body.pollIntervalSeconds);
    if (!Number.isFinite(p) || p < 10 || p > 3600)
      return res
        .status(400)
        .json({ ok: false, error: "invalid pollIntervalSeconds (10..3600)" });
    setState("poll_interval_seconds", String(Math.round(p)));
    applyPollInterval();
  }
  // OAuth settings (osu! client + user id) — persisted and applied on the fly.
  let oauthChanged = false;
  if (body.clientId != null && String(body.clientId).trim() !== "") {
    setState("oauth_client_id", String(body.clientId).trim());
    oauthChanged = true;
  }
  if (body.clientSecret != null && String(body.clientSecret).trim() !== "") {
    setState("oauth_client_secret", String(body.clientSecret).trim());
    oauthChanged = true;
  }
  if (body.userId != null && String(body.userId).trim() !== "") {
    const u = Number(body.userId);
    if (!Number.isFinite(u) || u <= 0)
      return res.status(400).json({ ok: false, error: "invalid userId" });
    setState("oauth_user_id", String(Math.round(u)));
    oauthChanged = true;
  }
  if (oauthChanged) {
    applyOAuthOverrides({
      clientId: getState("oauth_client_id"),
      clientSecret: getState("oauth_client_secret"),
      userId: Number(getState("oauth_user_id")) || null,
    });
    // the old client's tokens are worthless now
    resetAuthTokens();
    logoutUser();
  }
  res.json({
    ok: true,
    apiRpm: getCurrentRpm(),
    pollIntervalSeconds: getPollSeconds(),
  });
});

// Sends a test embed to the configured Discord webhook.
settingsRouter.post("/settings/discord-test", async (_req, res) => {
  const error = await sendTest();
  if (error) return res.status(400).json({ ok: false, error });
  res.json({ ok: true });
});
