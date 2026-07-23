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
import { applyPollInterval, getCountryRecheckHours } from "../sync/daemon.js";
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

function getPollSeconds(): number {
  const v = Number(getState("poll_interval_seconds"));
  return Number.isFinite(v) && v >= 10 ? v : config.pollIntervalSeconds;
}

settingsRouter.get("/settings", (_req, res) =>
  res.json({
    apiRpm: getCurrentRpm(),
    pollIntervalSeconds: getPollSeconds(),
    countryRecheckHours: getCountryRecheckHours(),
    display: getDisplayPrefs(),
    discord: getDiscordSettings(),
    oauth: {
      clientId: config.osuClientId,
      userId: config.osuUserId,
      secretSet: Boolean(config.osuClientSecret),
    },
    info: { port: config.port },
  })
);

settingsRouter.post("/settings", (req, res) => {
  const body = req.body as {
    apiRpm?: unknown;
    pollIntervalSeconds?: unknown;
    countryRecheckHours?: unknown;
    display?: { wither?: unknown };
    discord?: { webhookUrl?: unknown; bests?: unknown };
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
  const oauthBody = body as { clientId?: unknown; clientSecret?: unknown; userId?: unknown };
  let oauthChanged = false;
  if (oauthBody.clientId != null && String(oauthBody.clientId).trim() !== "") {
    setState("oauth_client_id", String(oauthBody.clientId).trim());
    oauthChanged = true;
  }
  if (oauthBody.clientSecret != null && String(oauthBody.clientSecret).trim() !== "") {
    setState("oauth_client_secret", String(oauthBody.clientSecret).trim());
    oauthChanged = true;
  }
  if (oauthBody.userId != null && String(oauthBody.userId).trim() !== "") {
    const u = Number(oauthBody.userId);
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
