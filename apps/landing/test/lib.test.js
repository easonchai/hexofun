import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { signSession, verifyPrivyToken, verifySession } from "../api/_lib.js";

const SECRET = "test-secret";
const ID = "0b0d6c1e-8a3f-4c55-9f0e-6f5a6a1e2b3c";

test("a signed session verifies", () => {
  assert.equal(verifySession(signSession(ID, SECRET), SECRET), ID);
});

test("a tampered id fails", () => {
  const [, sig] = signSession(ID, SECRET).split(".");
  assert.equal(verifySession(`${ID.replace("0b", "0c")}.${sig}`, SECRET), null);
});

test("a tampered signature fails", () => {
  const signed = signSession(ID, SECRET);
  const flipped = signed.slice(0, -1) + (signed.endsWith("0") ? "1" : "0");
  assert.equal(verifySession(flipped, SECRET), null);
  assert.equal(verifySession(`${ID}.short`, SECRET), null);
  assert.equal(verifySession(signed, "other-secret"), null);
  assert.equal(verifySession(undefined, SECRET), null);
});

// Local key pair standing in for Privy's JWKS.
const APP = "cm-test-app";
const { publicKey, privateKey } = await generateKeyPair("ES256");
const keySet = async () => publicKey;
const EMAIL = JSON.stringify([
  { type: "wallet", address: "So1ana", chain_type: "solana" },
  { type: "email", address: "Me@Example.com" },
]);

const mint = ({ aud = APP, iss = "privy.io", exp = "1h", claims = {} } = {}) =>
  new SignJWT({ linked_accounts: EMAIL, ...claims })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject("did:privy:abc")
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(privateKey);

const verify = (token) => verifyPrivyToken(token, { appId: APP, keySet });

test("a valid token returns the DID and the lowercased email", async () => {
  assert.deepEqual(await verify(await mint()), { did: "did:privy:abc", email: "me@example.com" });
});

test("a Google login gives the Google email", async () => {
  const google = JSON.stringify([
    { type: "google_oauth", subject: "123", email: "G@Gmail.com", name: "G" },
  ]);
  assert.deepEqual(await verify(await mint({ claims: { linked_accounts: google } })), {
    did: "did:privy:abc",
    email: "g@gmail.com",
  });
});

test("wrong audience or issuer is a 401", async () => {
  await assert.rejects(verify(await mint({ aud: "other-app" })), { status: 401 });
  await assert.rejects(verify(await mint({ iss: "evil.io" })), { status: 401 });
});

test("an expired token is a 401", async () => {
  await assert.rejects(verify(await mint({ exp: Math.floor(Date.now() / 1000) - 60 })), {
    status: 401,
  });
});

test("a token without an email account is a 400", async () => {
  const wallet = JSON.stringify([{ type: "wallet", address: "So1ana" }]);
  await assert.rejects(verify(await mint({ claims: { linked_accounts: wallet } })), {
    status: 400,
  });
  await assert.rejects(verify(await mint({ claims: { linked_accounts: "not json" } })), {
    status: 400,
  });
});
