import { Router } from "express";
import { getDb } from "../db/db.js";
import { evalMetric, previewMetric } from "../logic/metricEval.js";
import type { MetricParams } from "../logic/metrics.js";

// Custom metrics (milestones + evolution)
export const metricsRouter = Router();

metricsRouter.get("/metrics", (req, res) => {
  const db = getDb();
  const gran = req.query.granularity === "day" ? "day" : "month";
  const rows = db
    .prepare("SELECT id, name, params FROM metrics ORDER BY sort_order, id")
    .all() as { id: number; name: string; params: string }[];
  res.json({
    metrics: rows.map((r) => {
      const params = JSON.parse(r.params) as MetricParams;
      return { id: r.id, name: r.name, params, ...evalMetric(params, gran) };
    }),
  });
});

// Live preview for the builder: count + per-star-rating breakdown, unsaved.
metricsRouter.post("/metrics/preview", (req, res) => {
  try {
    res.json(previewMetric(req.body as MetricParams));
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e) });
  }
});

metricsRouter.post("/metrics", (req, res) => {
  const body = req.body as { name?: unknown; params?: MetricParams };
  const name = String(body.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "name required" });
  const params = body.params;
  if (!params || (params.kind !== "count" && params.kind !== "ranked_score"))
    return res.status(400).json({ ok: false, error: "invalid metric" });
  if (!(Number(params.step) > 0))
    return res.status(400).json({ ok: false, error: "invalid step" });
  try {
    previewMetric(params); // validates the conditions compile
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
  const order =
    (getDb().prepare("SELECT COALESCE(MAX(sort_order), 0) m FROM metrics").get() as {
      m: number;
    }).m + 1;
  getDb()
    .prepare("INSERT INTO metrics (name, params, sort_order) VALUES (?, ?, ?)")
    .run(name, JSON.stringify(params), order);
  res.json({ ok: true });
});

metricsRouter.put("/metrics/:id", (req, res) => {
  const id = Number(req.params.id);
  const body = req.body as { name?: unknown; params?: MetricParams };
  const name = String(body.name ?? "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "name required" });
  const params = body.params;
  if (!params || (params.kind !== "count" && params.kind !== "ranked_score"))
    return res.status(400).json({ ok: false, error: "invalid metric" });
  if (!(Number(params.step) > 0))
    return res.status(400).json({ ok: false, error: "invalid step" });
  try {
    previewMetric(params);
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
  getDb()
    .prepare("UPDATE metrics SET name = ?, params = ? WHERE id = ?")
    .run(name, JSON.stringify(params), id);
  res.json({ ok: true });
});

metricsRouter.delete("/metrics/:id", (req, res) => {
  getDb().prepare("DELETE FROM metrics WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});
