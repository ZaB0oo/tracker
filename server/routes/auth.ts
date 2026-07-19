import { Router } from "express";
import { getState, setState } from "../db/db.js";
import {
  exchangeAuthCode,
  fetchUserProfile,
  getAuthorizeUrl,
  isUserConnected,
  logoutUser,
} from "../osu/api.js";
import { runFrSweep } from "../sync/daemon.js";

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
    void runFrSweep();
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
    | { username: string; avatar_url: string; country_code?: string }
    | null = null;
  if (connected) {
    try {
      profile = JSON.parse(getState("user_profile") || "null");
    } catch {
      profile = null;
    }
    // refetch if missing, or cached before country_code existed
    if ((!profile || !profile.country_code) && !profileFetchInFlight) {
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
