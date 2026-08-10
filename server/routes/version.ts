import { Router } from "express";
import { readFileSync } from "node:fs";

/**
 * Single source of truth: the root package.json version (also what
 * electron-builder stamps into the installers). Resolved relative to this
 * module: two levels up from source (server/routes), three from dist.
 */
function readVersion(): string {
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      const pkg = JSON.parse(
        readFileSync(new URL(rel, import.meta.url), "utf8")
      ) as { name?: string; version?: string };
      if (pkg.name === "osu-completionist-tracker" && pkg.version)
        return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
}
export const APP_VERSION = readVersion();

const REPO = "ZaB0oo/tracker";
const CHECK_TTL_MS = 24 * 3600 * 1000;

/**
 * Latest published release, via the /releases/latest redirect (no GitHub API
 * quota: the Location header carries the tag). null when offline / no release.
 */
async function fetchLatest(): Promise<{ tag: string; url: string } | null> {
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
      redirect: "manual",
    });
    const loc = res.headers.get("location");
    const m = loc?.match(/\/releases\/tag\/(v?[\d.]+)$/);
    if (m && loc) return { tag: m[1], url: loc };
  } catch {
    // offline or GitHub unreachable: report nothing rather than fail
  }
  return null;
}

/** true when a > b (semver-ish "1.7.10" vs "1.7.2", leading v ignored). */
function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

let cache: { at: number; latest: { tag: string; url: string } | null } | null =
  null;

export const versionRouter = Router();

// Current version + available update (checked at most once a day).
versionRouter.get("/version", async (_req, res) => {
  if (!cache || Date.now() - cache.at > CHECK_TTL_MS)
    cache = { at: Date.now(), latest: await fetchLatest() };
  const latest = cache.latest;
  const update = latest && isNewer(latest.tag, APP_VERSION) ? latest : null;
  res.json({
    current: APP_VERSION,
    // true when this server was launched by the desktop app — the dev UI uses
    // it to detect that its /api proxy landed on the WRONG server (port taken)
    desktop: Boolean(process.env.TRACKER_DESKTOP),
    update: update
      ? { version: update.tag.replace(/^v/, ""), url: update.url }
      : null,
  });
});
