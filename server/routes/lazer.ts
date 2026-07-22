import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router, type Request } from "express";
import { config } from "../config.js";
import { buildCollectionDb } from "./table.js";

/**
 * Direct import of collections into osu!lazer, delegated to the standalone
 * LazerCollectionImporter executable (which owns all the realm safety:
 * automatic backup, schema-version detection, refusal while osu! runs).
 *
 * Security model:
 * - the executable path comes ONLY from the environment (LAZER_IMPORTER_PATH),
 *   never from a request — the API cannot be used to run arbitrary programs;
 * - execFile with an argument array (no shell → no injection), and the only
 *   variable argument is a temp file path generated server-side;
 * - loopback-only: writing to the local osu! database is not something a
 *   LAN client should ever be able to trigger.
 */
export const lazerRouter = Router();

function isLoopback(req: Request): boolean {
  const a = req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

async function importerPath(): Promise<string | null> {
  const p = config.lazerImporterPath;
  if (!p || !path.isAbsolute(p)) return null;
  try {
    await fs.access(p);
    return p;
  } catch {
    return null;
  }
}

// The UI shows the "import into lazer" button only when this says available.
lazerRouter.get("/lazer-import/status", async (req, res) => {
  res.json({ available: isLoopback(req) && (await importerPath()) != null });
});

/**
 * POST /api/lazer-import?name=...&<same filters as /table>
 * Builds the collection.db for the current filters and hands it to the
 * importer (merge mode: nothing is ever deleted in lazer).
 */
lazerRouter.post("/lazer-import", async (req, res) => {
  if (!isLoopback(req))
    return res.status(403).json({ ok: false, error: "local requests only" });
  const exe = await importerPath();
  if (!exe)
    return res.status(400).json({
      ok: false,
      error: "LAZER_IMPORTER_PATH is not set (or the file does not exist) — see .env.example",
    });

  const built = await buildCollectionDb(req.query as Record<string, string | undefined>);
  if ("error" in built)
    return res.status(built.status).json({ ok: false, error: built.error });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lazer-import-"));
  const file = path.join(dir, "collection.db");
  try {
    await fs.writeFile(file, built.buffer);

    // --yes: non-interactive; no --force: the importer still refuses while
    // osu! is running, and that message is surfaced to the UI below.
    const out = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      execFile(
        exe,
        [file, "--yes"],
        { timeout: 120_000, windowsHide: true },
        (err, stdout, stderr) =>
          resolve({ ok: err == null, output: `${stdout}\n${stderr}` })
      );
    });

    const m = out.output.match(
      /RESULT created=(\d+) updated=(\d+) hashes=(\d+) invalid=(\d+)/
    );
    if (!out.ok || !m) {
      const tail = out.output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" · ");
      return res
        .status(502)
        .json({ ok: false, error: tail || "importer failed without output" });
    }

    res.json({
      ok: true,
      mapCount: built.mapCount,
      created: Number(m[1]),
      updated: Number(m[2]),
      hashes: Number(m[3]),
      invalid: Number(m[4]),
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
