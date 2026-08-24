import express from "express";
import path from "node:path";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getDb } from "./db/db.js";
import { router } from "./routes.js";
import { startCatalogRefresh, startPolling } from "./sync/daemon.js";
import { startPpBackfill } from "./osu/ppFill.js";
import { getCurrentRpm } from "./osu/api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Node kills the process on any unhandled promise rejection: one failing
// background task (backfill resume, sweep kick-off, …) must not take the
// whole tracker down with it. Log and keep serving. Same for synchronous
// throws in timer callbacks (a transient SQLITE_BUSY in the poll tick used to
// kill the server, and the desktop app quit with it).
process.on("unhandledRejection", (e) => {
  console.error("[server] unhandled rejection:", e);
});
process.on("uncaughtException", (e) => {
  console.error("[server] uncaught exception:", e);
});

const app = express();
app.use(express.json());
// gzip for the JSON payloads (the timeline alone is ~1MB): plain node:zlib
// instead of a middleware dependency, applied only above a size floor
app.use("/api", (req, res, next) => {
  if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) return next();
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const buf = Buffer.from(JSON.stringify(body));
    if (buf.length < 8192) return json(body);
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Vary", "Accept-Encoding");
    res.send(gzipSync(buf, { level: 6 }));
    return res;
  };
  next();
});
app.use("/api", router);

// In prod (npm run build && npm start) we serve the built frontend.
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) =>
    res.sendFile(path.join(webDist, "index.html"))
  );
}

// Staged DB import (Settings → Import database) is applied by getDb(), the only
// place that opens the file — this call also creates the schema on first launch.
getDb();

// Startup repair: drop stored scores osu! does not honor (played while the
// map had no leaderboard) and recompute the affected bests. No-op when clean.
import { cleanupPreLeaderboardScores, repairZeroComboFc } from "./logic/repo.js";
const cleaned = cleanupPreLeaderboardScores();
if (cleaned.deleted > 0)
  console.log(
    `[db] cleanup: ${cleaned.deleted} pre-leaderboard score(s) removed on ${cleaned.maps} map(s)`
  );
// Startup repair: phantom perfect FCs minted by the max_combo = 0 sentinel.
const fcFix = repairZeroComboFc();
if (fcFix.scores > 0)
  console.log(
    `[db] repair: fc_state of ${fcFix.scores} score(s) on ${fcFix.maps} map(s) without a combo reference recomputed`
  );

// OAuth settings saved from the UI (take priority over .env)
import { getState } from "./db/db.js";
import { applyOAuthOverrides } from "./config.js";
applyOAuthOverrides({
  clientId: getState("oauth_client_id"),
  clientSecret: getState("oauth_client_secret"),
  userId: Number(getState("oauth_user_id")) || null,
});

// Loopback by default: the API has no authentication, and exposing it to the
// LAN exposes the whole database (and CSRF-able maintenance actions). Set
// HOST=0.0.0.0 explicitly to serve other devices (e.g. OBS on another PC).
const HOST = process.env.HOST ?? "127.0.0.1";
const server = app.listen(config.port, HOST, () => {
  console.log(`[server] http://localhost:${config.port}`);
  if (config.hasCredentials) {
    console.log(
      `[server] user osu!: ${config.osuUserId}, rate limit: ${getCurrentRpm()} req/min`
    );
    console.log(
      `[sync] polling every ${config.pollIntervalSeconds}s. ` +
        `Start the initial sync from the UI or: curl -X POST http://localhost:${config.port}/api/sync/start`
    );
  } else {
    // First launch without .env: the server must still boot so the UI can be
    // used to enter the credentials (Settings menu). Sync stays dormant.
    console.log(
      `[server] no osu! credentials yet — open http://localhost:${config.port} ` +
        `and fill them in the Settings menu (or copy .env.example to .env). ` +
        `Syncing starts as soon as they are set.`
    );
  }
  startPolling();
  startCatalogRefresh();
  startPpBackfill();
});
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    // The desktop app keeps its own server on the same port (tray!): without
    // this, the dev web UI silently proxies to the OTHER instance and its
    // database — very confusing. Fail loudly instead.
    console.error(
      `[server] port ${config.port} is already in use — another osu!completionist ` +
        "is running (check the tray icon of the desktop app, or an old dev " +
        "server). Close it, or you will be looking at ITS database through this UI."
    );
    process.exit(1);
  }
  throw e;
});
