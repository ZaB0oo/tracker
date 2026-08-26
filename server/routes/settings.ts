import express, { Router, type Request } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOAuthOverrides, config } from "../config.js";
import { getActiveRulesets, getDb, getState, setState } from "../db/db.js";
import {
  applyApiRpm,
  getCurrentRpm,
  logoutUser,
  MAX_RPM,
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
  DEFAULT_TEMPLATE,
  sampleBestPreview,
  sendTest,
  sendTestBest,
  setDiscordSettings,
} from "../notify/discord.js";

export const settingsRouter = Router();

// Local-only guard for sensitive settings (executable path, DB import): a LAN
// client must never be able to point the app at an arbitrary program or DB.
function isLoopback(req: Request): boolean {
  const a = req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

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
    apiRpmMax: MAX_RPM,
    pollIntervalSeconds: getPollSeconds(),
    countryRecheckHours: getCountryRecheckHours(),
    globalRecheckHours: getGlobalRecheckHours(),
    display: getDisplayPrefs(),
    discord: { ...getDiscordSettings(), templateDefault: DEFAULT_TEMPLATE },
    // safe accessors: on a first launch without .env the getters throw —
    // the settings UI is precisely where the values get filled in
    oauth: {
      clientId: safe(() => config.osuClientId, ""),
      userId: safe(() => config.osuUserId, 0),
      secretSet: safe(() => Boolean(config.osuClientSecret), false),
    },
    // desktop: set from the UI (stored in DB); .env stays the fallback
    lazerImporterPath:
      getState("lazer_importer_path") ?? config.lazerImporterPath ?? "",
    activeRulesets: getActiveRulesets(),
    info: { port: config.port },
  })
);

// Staged DB import: the file is written next to the live DB and swapped in at
// the NEXT startup (swapping under a live server is unsafe). Loopback only.
settingsRouter.post(
  "/settings/import-db",
  express.raw({ type: "*/*", limit: "16gb" }),
  (req, res) => {
    if (!isLoopback(req))
      return res.status(403).json({ ok: false, error: "local requests only" });
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length < 100)
      return res.status(400).json({ ok: false, error: "empty upload" });
    if (!buf.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "latin1")))
      return res
        .status(400)
        .json({ ok: false, error: "not a SQLite database file" });
    try {
      fs.writeFileSync(`${config.dbPath}.import`, buf);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
    res.json({
      ok: true,
      note: "Import staged: restart the app to apply it (the current database is kept as a backup).",
    });
  }
);

settingsRouter.post("/settings", (req, res) => {
  const body = req.body as {
    apiRpm?: unknown;
    pollIntervalSeconds?: unknown;
    countryRecheckHours?: unknown;
    globalRecheckHours?: unknown;
    display?: { wither?: unknown; estPerf?: unknown };
    discord?: {
      webhookUrl?: unknown;
      bests?: unknown;
      template?: {
        title?: unknown;
        body?: unknown;
        cover?: unknown;
        footer?: unknown;
        author?: unknown;
      } | null;
    };
    clientId?: unknown;
    clientSecret?: unknown;
    userId?: unknown;
    lazerImporterPath?: unknown;
    activeRulesets?: unknown;
  };
  if (Array.isArray(body.activeRulesets)) {
    const wanted = new Set(
      body.activeRulesets.map(Number).filter((n) => [0, 1, 2, 3].includes(n))
    );
    if (wanted.size === 0)
      return res
        .status(400)
        .json({ ok: false, error: "at least one ruleset must stay enabled" });
    // std included: disabling it stops its polling/backfill/sweeps — the
    // views stay readable. Non-std activation only unlocks the views: their
    // processes wait for the per-mode "Start initial sync" button.
    setState("active_rulesets", [...wanted].sort().join(","));
  }
  // executable path: loopback only (see the lazer-import security model)
  if (body.lazerImporterPath != null) {
    if (!isLoopback(req))
      return res
        .status(403)
        .json({ ok: false, error: "importer path: local requests only" });
    setState("lazer_importer_path", String(body.lazerImporterPath).trim());
  }
  if (body.discord != null) {
    const err = setDiscordSettings({
      webhookUrl:
        body.discord.webhookUrl == null ? null : String(body.discord.webhookUrl),
      bests: body.discord.bests == null ? undefined : Boolean(body.discord.bests),
      template: body.discord.template,
    });
    if (err) return res.status(400).json({ ok: false, error: err });
  }
  if (body.display != null) {
    setDisplayPrefs({
      wither:
        body.display.wither == null ? undefined : Boolean(body.display.wither),
      estPerf:
        body.display.estPerf == null ? undefined : Boolean(body.display.estPerf),
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
    if (!Number.isFinite(r) || r < 1 || r > MAX_RPM)
      return res.status(400).json({
        ok: false,
        error: `invalid apiRpm (1..${MAX_RPM}, documented osu! limit)`,
      });
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

// A random real best as template variables + embed chrome (editor preview).
settingsRouter.get("/settings/discord-sample", async (req, res) => {
  const raw = Number(req.query.ruleset);
  const sample = await sampleBestPreview(
    [0, 1, 2, 3].includes(raw) ? raw : 0,
    req.query.honors === "1"
  );
  if (!sample)
    return res.status(404).json({ ok: false, error: "no best score to sample yet" });
  res.json(sample);
});

// Sends a RANDOM REAL best through the live notification pipeline (render test).
settingsRouter.post("/settings/discord-test-best", async (req, res) => {
  const raw = Number((req.body as { ruleset?: unknown } | undefined)?.ruleset);
  const error = await sendTestBest([0, 1, 2, 3].includes(raw) ? raw : 0);
  if (error) return res.status(400).json({ ok: false, error });
  res.json({ ok: true });
});
