import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router, type Request } from "express";
import { config } from "../config.js";
import { getState } from "../db/db.js";
import { buildCollectionDb } from "./table.js";

/**
 * Direct import of collections into osu!lazer, delegated to the standalone
 * LazerCollectionImporter executable (which owns all the realm safety:
 * automatic backup, schema-version detection, refusal while osu! runs).
 *
 * Security model:
 * - the executable path comes from the environment (LAZER_IMPORTER_PATH) or
 *   from the Settings UI — and changing it via the API is LOOPBACK-ONLY, so a
 *   LAN client can never point the app at an arbitrary program;
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
  const p = getState("lazer_importer_path") || config.lazerImporterPath;
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
      error:
        "LazerCollectionImporter path is not set (or the file does not exist) — Settings → Integrations",
    });

  const built = await buildCollectionDb(req.query as Record<string, string | undefined>);
  if ("error" in built)
    return res.status(built.status).json({ ok: false, error: built.error });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lazer-import-"));
  const file = path.join(dir, "collection.db");
  const idsFile = path.join(dir, "ids.json");
  try {
    await fs.writeFile(file, built.buffer);
    // md5 -> beatmap id sidecar: the importer remaps hashes of outdated local
    // maps to the hash of the version actually installed in lazer.
    await fs.writeFile(idsFile, JSON.stringify(built.md5ToId));

    // --yes: non-interactive; no --force: the importer still refuses while
    // osu! is running, and that message is surfaced to the UI below.
    const out = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      execFile(
        exe,
        [file, "--ids", idsFile, "--yes"],
        { timeout: 120_000, windowsHide: true },
        (err, stdout, stderr) =>
          resolve({ ok: err == null, output: `${stdout}\n${stderr}` })
      );
    });

    const m = out.output.match(
      /RESULT created=(\d+) updated=(\d+) hashes=(\d+) invalid=(\d+)(?: remapped=(\d+) notinstalled=(\d+))?/
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
      remapped: m[5] != null ? Number(m[5]) : 0,
      notInstalled: m[6] != null ? Number(m[6]) : 0,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
