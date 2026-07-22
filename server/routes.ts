/** API router: one module per domain, all mounted under /api. */
import { Router } from "express";
import { authRouter } from "./routes/auth.js";
import { historyRouter } from "./routes/history.js";
import { lazerRouter } from "./routes/lazer.js";
import { metricsRouter } from "./routes/metrics.js";
import { settingsRouter } from "./routes/settings.js";
import { statsRouter } from "./routes/stats.js";
import { syncRouter } from "./routes/sync.js";
import { tableRouter } from "./routes/table.js";

export const router = Router();
router.use(tableRouter);
router.use(lazerRouter);
router.use(statsRouter);
router.use(metricsRouter);
router.use(historyRouter);
router.use(settingsRouter);
router.use(authRouter);
router.use(syncRouter);
