import test from "node:test";
import assert from "node:assert/strict";
import { dropForeignSession } from "../src/foreign-session.js";

const OURS = "cmtlbhuh402u30cjv957bvump";
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
// Privy stores each token JSON-encoded.
const jwt = (claims) => JSON.stringify(`${b64url({ alg: "ES256" })}.${b64url(claims)}.sig`);

const storage = (entries) => {
  const m = new Map(Object.entries(entries));
  return { getItem: (k) => m.get(k) ?? null, removeItem: (k) => m.delete(k), keys: () => [...m.keys()] };
};

test("drops a session issued by another Privy app", () => {
  const s = storage({ "privy:token": jwt({ aud: "cmi5qoOTHER" }), "privy:refresh_token": '"r"', other: "x" });
  assert.equal(dropForeignSession(s, OURS), true);
  assert.deepEqual(s.keys(), ["other"]);
});

test("keeps our own session", () => {
  const s = storage({ "privy:token": jwt({ aud: OURS }), "privy:pat": jwt({ aid: OURS }), "privy:refresh_token": '"r"' });
  assert.equal(dropForeignSession(s, OURS), false);
  assert.equal(s.keys().length, 3);
});

test("drops an unreadable token, leaves an empty store alone", () => {
  assert.equal(dropForeignSession(storage({ "privy:pat": '"garbage"' }), OURS), true);
  assert.equal(dropForeignSession(storage({}), OURS), false);
});
