import type { Request, RequestHandler } from "express";

// The API has no authentication: these two checks are the whole line between
// "a page open in the user's browser" and "the user's database".

export function isLoopback(req: Request): boolean {
  const a = req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

// Host must be localhost or an IP literal (the LAN address when HOST=0.0.0.0).
// A DNS name resolving to 127.0.0.1 (DNS rebinding) is the only thing this
// rejects: a page on attacker.example cannot read the API through its own name.
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.replace(/:\d+$/, "").toLowerCase();
  return (
    h === "localhost" ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ||
    (h.startsWith("[") && h.endsWith("]"))
  );
}

// Browsers send Sec-Fetch-Site (and Origin on cross-origin requests); curl,
// the desktop shell and the app's own pages pass. Body-less POSTs and
// text/plain bodies are "simple" requests that need no preflight, so every
// mutating route must be behind this.
function isSameOrigin(req: Request): boolean {
  const sfs = req.headers["sec-fetch-site"];
  if (sfs && sfs !== "same-origin" && sfs !== "none") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export const apiGuard: RequestHandler = (req, res, next) => {
  if (!hostAllowed(req.headers.host))
    return res.status(403).json({ ok: false, error: "host not allowed" });
  const safeMethod = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (!safeMethod && !isSameOrigin(req))
    return res.status(403).json({ ok: false, error: "cross-origin request refused" });
  next();
};
