import { Router } from "express";
import { getState, setState } from "../db/db.js";
import {
  exchangeAuthCode,
  fetchUserProfile,
  getAuthorizeUrl,
  isUserConnected,
  logoutUser,
} from "../osu/api.js";
import { runCountrySweep } from "../sync/daemon.js";

// User OAuth (country leaderboards, requires supporter)
export const authRouter = Router();

authRouter.get("/auth/login", (_req, res) => res.redirect(getAuthorizeUrl()));

authRouter.get("/auth/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) return res.status(400).send("Missing code");
  try {
    await exchangeAuthCode(code);
    try {
      const profile = await fetchUserProfile();
      if (profile) setState("user_profile", JSON.stringify(profile));
    } catch {
      /* profile will be fetched later via /auth/status */
    }
    void runCountrySweep();
    res.send(
      "<body style='background:#17131f;color:#e8e3f2;font-family:sans-serif'>" +
        "<h2>osu! account connected ✔</h2><p>The country leaderboard sweep is " +
        "starting. You can close this tab.</p></body>"
    );
  } catch (e) {
    res.status(500).send(`Login failed: ${String(e)}`);
  }
});

let profileFetchInFlight = false;

authRouter.get("/auth/status", (_req, res) => {
  const connected = isUserConnected();
  let profile:
    | {
        username: string;
        avatar_url: string;
        cover_url?: string;
        country_code?: string;
        stats?: unknown;
      }
    | null = null;
  if (connected) {
    try {
      profile = JSON.parse(getState("user_profile") || "null");
    } catch {
      profile = null;
    }
    // refetch if missing, or cached by an older version (fields added since)
    const stale =
      !profile ||
      !profile.country_code ||
      profile.cover_url == null ||
      (profile.stats as { join_date?: string } | undefined)?.join_date == null;
    if (stale && !profileFetchInFlight) {
      profileFetchInFlight = true;
      void fetchUserProfile()
        .then((p) => {
          if (p) setState("user_profile", JSON.stringify(p));
        })
        .catch(() => undefined)
        .finally(() => {
          profileFetchInFlight = false;
        });
    }
  }
  res.json({ connected, profile });
});

authRouter.post("/auth/logout", (_req, res) => {
  logoutUser();
  res.json({ ok: true });
});

// ---------- Profile images for the share card ----------
// An SVG exported through a canvas cannot reference external images (they are
// simply not loaded in <img> mode), so the banner/avatar are proxied here and
// inlined as base64 data URLs. Cached 10 min; assets, not API => no limiter.

let imgCache: { at: number; data: { avatar: string | null; cover: string | null } } | null =
  null;

async function toDataUrl(url: string | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8_000_000) return null; // keep the SVG payload sane
    const ct = r.headers.get("content-type") ?? "image/jpeg";
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

authRouter.get("/profile-images", async (_req, res) => {
  if (imgCache && Date.now() - imgCache.at < 10 * 60_000)
    return res.json(imgCache.data);
  let profile: { avatar_url?: string; cover_url?: string } | null = null;
  try {
    profile = JSON.parse(getState("user_profile") || "null");
  } catch {
    /* no profile */
  }
  const [avatar, cover] = await Promise.all([
    toDataUrl(profile?.avatar_url),
    toDataUrl(profile?.cover_url),
  ]);
  imgCache = { at: Date.now(), data: { avatar, cover } };
  res.json({ avatar, cover });
});
