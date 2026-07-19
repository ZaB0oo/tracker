import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getDb } from "./db/db.js";
import { router } from "./routes.js";
import { startCatalogRefresh, startPolling } from "./sync/daemon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use("/api", router);

// In prod (npm run build && npm start) we serve the built frontend.
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) =>
    res.sendFile(path.join(webDist, "index.html"))
  );
}

getDb(); // creates the schema on first launch

// OAuth settings saved from the UI (take priority over .env)
import { getState } from "./db/db.js";
import { applyOAuthOverrides } from "./config.js";
applyOAuthOverrides({
  clientId: getState("oauth_client_id"),
  clientSecret: getState("oauth_client_secret"),
  userId: Number(getState("oauth_user_id")) || null,
});

const server = app.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  console.log(`[server] user osu!: ${config.osuUserId}, rate limit: ${config.apiRpm} req/min`);
  startPolling();
  startCatalogRefresh();
  console.log(
    `[sync] polling every ${config.pollIntervalSeconds}s. ` +
      `Start the initial sync from the UI or: curl -X POST http://localhost:${config.port}/api/sync/start`
  );
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `\n[ERROR] Port ${config.port} is already in use: an OLD server is still running!\n` +
        `Close all old terminals / node processes (taskkill /F /IM node.exe on Windows),\n` +
        `then restart npm run dev. Otherwise the old code keeps running.\n`
    );
    process.exit(1);
  }
  throw e;
});
