import { randomBytes } from "node:crypto";
import { configured, sessionId } from "../_lib.js";
import { authorizeUrl, newVerifier, xCookie } from "../_x.js";

/** `PUBLIC_ORIGIN` pins the callback host; without it the request's own host is used. */
export const origin = (req) =>
  process.env.PUBLIC_ORIGIN || `https://${req.headers.host}`;

/**
 * Start of the X connect. Needs the session cookie. Parks a state and PKCE
 * verifier in a ten minute cookie and sends the browser to X to approve.
 * No network call, so nothing here can fail after the checks.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured(res, "X_CLIENT_ID", "X_CLIENT_SECRET", "SESSION_SECRET")) return;

  res.setHeader("Cache-Control", "no-store");
  if (!sessionId(req, process.env.SESSION_SECRET)) {
    return res.status(401).json({ error: "Not signed in" });
  }

  const state = randomBytes(16).toString("base64url");
  const verifier = newVerifier();
  res.setHeader("Set-Cookie", xCookie(state, verifier, process.env.SESSION_SECRET));
  res.setHeader(
    "Location",
    authorizeUrl({
      clientId: process.env.X_CLIENT_ID,
      redirectUri: `${origin(req)}/api/x/callback`,
      state,
      verifier,
    }),
  );
  return res.status(302).end();
}
