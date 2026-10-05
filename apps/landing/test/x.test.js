import test from "node:test";
import assert from "node:assert/strict";
import { authorizeUrl, challengeOf, newVerifier, parseAvatar, xCookie, readXCookie } from "../api/_x.js";
import { signSession } from "../api/_lib.js";

test("PKCE challenge matches RFC 7636 appendix B", () => {
  assert.equal(
    challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  assert.match(newVerifier(), /^[A-Za-z0-9_-]{43}$/);
});

test("authorize URL carries the code flow params", () => {
  const u = new URL(
    authorizeUrl({ clientId: "cid", redirectUri: "http://localhost:8080/api/x/callback", state: "st", verifier: "v" }),
  );
  assert.equal(u.origin + u.pathname, "https://x.com/i/oauth2/authorize");
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual(q, {
    response_type: "code",
    client_id: "cid",
    redirect_uri: "http://localhost:8080/api/x/callback",
    scope: "users.read tweet.read",
    state: "st",
    code_challenge: challengeOf("v"),
    code_challenge_method: "S256",
  });
});

// ----------------------------- temp cookie ----------------------------------

const reqWith = (cookie) => ({ headers: { cookie } });
const valueOf = (setCookie) => setCookie.split(";")[0];

test("x cookie round-trips state and verifier", () => {
  const c = xCookie("st", "ver", "S");
  assert.match(c, /Max-Age=600/);
  assert.match(c, /Path=\/api\/x/);
  assert.deepEqual(readXCookie(reqWith(`a=b; ${valueOf(c)}`), "S"), { state: "st", verifier: "ver" });
});

test("x cookie rejects a wrong secret, tampering and a session cookie", () => {
  const v = valueOf(xCookie("st", "ver", "S"));
  assert.equal(readXCookie(reqWith(v), "other"), null);
  assert.equal(readXCookie(reqWith(v.replace("hexo_x=", "hexo_x=z")), "S"), null);
  assert.equal(readXCookie(reqWith(`hexo_x=${signSession("just-an-id", "S")}`), "S"), null);
  assert.equal(readXCookie(reqWith(""), "S"), null);
});

test("parseAvatar keeps X's CDN only, at 400px", () => {
  const base = "https://pbs.twimg.com/profile_images/1661201415899951105/azNjKOSH";
  assert.equal(parseAvatar(`${base}_normal.jpg`), `${base}_400x400.jpg`);
  assert.equal(parseAvatar(`${base}_normal.png`), `${base}_400x400.png`);
  assert.equal(parseAvatar("https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png"), null);
  assert.equal(parseAvatar("http://pbs.twimg.com/a_normal.jpg"), null);
  assert.equal(parseAvatar("https://pbs.twimg.com.evil.example/a.jpg"), null);
  assert.equal(parseAvatar(undefined), null);
});
