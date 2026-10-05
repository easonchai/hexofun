import { createHash, randomBytes } from "node:crypto";
import { getCookie, signSession, verifySession } from "./_lib.js";

// X OAuth 2.0 authorization code flow with PKCE, confidential client.
// Identity is one GET /2/users/me after the token exchange. Checked
// 2026-10-01: it succeeds on a pay-per-use account with $0 credits.
// The app must sit inside a Project, or v2 answers 403 client-not-enrolled.
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const ME_URL = "https://api.x.com/2/users/me?user.fields=profile_image_url";
const SCOPES = "users.read tweet.read"; // users/me needs both

const b64url = (buf) => buf.toString("base64url");
export const newVerifier = () => b64url(randomBytes(32));
export const challengeOf = (verifier) => b64url(createHash("sha256").update(verifier).digest());

export function authorizeUrl({ clientId, redirectUri, state, verifier }) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${q}`;
}

// Messages carry X's error body (e.g. invalid_request, CreditsDepleted), never secrets.
async function call(what, url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`X ${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return { res, json: JSON.parse(text) };
}

/** The avatar URL worth keeping: X's https CDN only, at 400px instead of the
 *  48px `_normal` it returns. Anything else is null, so the card never
 *  fetches a host we didn't expect. */
export function parseAvatar(raw) {
  if (typeof raw !== "string" || !raw.startsWith("https://pbs.twimg.com/")) return null;
  return raw.replace(/_normal(\.\w+)$/, "_400x400$1").slice(0, 500);
}

/** Code -> access token -> `{ userId, screenName, avatar }`. The token is dropped here. */
export async function identify({ clientId, clientSecret, code, redirectUri, verifier }) {
  const { json: tok } = await call("token", TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
    }),
  });
  const { json: me } = await call("users/me", ME_URL, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  const userId = me.data?.id;
  const screenName = me.data?.username;
  if (!userId || !screenName) throw new Error("X users/me failed: missing identity in response");
  return { userId, screenName, avatar: parseAvatar(me.data.profile_image_url) };
}

// State and PKCE verifier ride between /start and /callback in this cookie:
// signed like the session (prefix keeps the two from being swapped), ten
// minutes, only sent to /api/x/*. Lax so it survives the redirect back from x.com.
const X_COOKIE = "hexo_x";
const X_COOKIE_FLAGS = "Path=/api/x; HttpOnly; Secure; SameSite=Lax";

export const xCookie = (state, verifier, sessionSecret) =>
  `${X_COOKIE}=${signSession(`x:${state}:${verifier}`, sessionSecret)}; ${X_COOKIE_FLAGS}; Max-Age=600`;

export const clearXCookie = `${X_COOKIE}=; ${X_COOKIE_FLAGS}; Max-Age=0`;

/** `{ state, verifier }` from a request's cookie, or null when missing or forged. */
export function readXCookie(req, sessionSecret) {
  const parts = verifySession(getCookie(req, X_COOKIE), sessionSecret)?.split(":");
  return parts?.length === 3 && parts[0] === "x" ? { state: parts[1], verifier: parts[2] } : null;
}
