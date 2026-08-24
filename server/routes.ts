/** API router: one module per domain, all mounted under /api. */
import { Router } from "express";
import { authRouter } from "./routes/auth.js";
import { historyRouter } from "./routes/history.js";
import { lazerRouter } from "./routes/lazer.js";
import { metricsRouter } from "./routes/metrics.js";
import { packsRouter } from "./routes/packs.js";
import { sessionsRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { statsRouter } from "./routes/stats.js";
import { syncRouter } from "./routes/sync.js";
import { tableRouter } from "./routes/table.js";
import { versionRouter } from "./routes/version.js";

export const router = Router();
router.use(tableRouter);
router.use(lazerRouter);
router.use(statsRouter);
router.use(sessionsRouter);
router.use(metricsRouter);
router.use(packsRouter);
router.use(historyRouter);
router.use(settingsRouter);
router.use(authRouter);
router.use(syncRouter);
router.use(versionRouter);
