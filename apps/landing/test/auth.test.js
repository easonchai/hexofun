import test from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, loadMember, useSql } from "../api/_lib.js";
import handler, { signIn } from "../api/auth/privy.js";
import { POINTS } from "../api/_points.js";

// Same harness as points.test.js: needs TEST_DATABASE_URL and pg.
const url = process.env.TEST_DATABASE_URL;
const pg = url ? await import("pg").catch(() => null) : null;
const skip = !pg && "set TEST_DATABASE_URL (and have pg installed) to run";

const schema = `landing_auth_${process.pid}`;
let pool;

test.before(async () => {
  if (skip) return;
  const { Pool } = pg.default;
  const admin = new Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  useSql((strings, ...vals) =>
    pool.query(strings.reduce((q, s, i) => `${q}$${i}${s}`), vals).then((r) => r.rows),
  );
  await ensureSchema();
});

test.after(async () => {
  if (skip) return;
  await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

test("a post that is not JSON is refused before anything else", async () => {
  // What a cross-site form can send without a preflight.
  for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
    const out = {};
    const res = { setHeader() {}, status: (c) => ((out.status = c), res), json() {} };
    await handler({ method: "POST", headers: { "content-type": type }, body: { idToken: "t" } }, res);
    assert.equal(out.status, 415);
  }
});

const row = async (id) =>
  (await pool.query("select email, privy_did, code, referred_by from waitlist where id = $1", [id]))
    .rows[0];

test("a new email makes a row with the DID, and the DID finds it again", { skip }, async () => {
  const a = await signIn({ did: "did:privy:new", email: "new@example.com" });
  assert.equal(a.created, true);
  assert.equal((await row(a.id)).privy_did, "did:privy:new");
  const b = await signIn({ did: "did:privy:new", email: "new@example.com" });
  assert.deepEqual(b, { id: a.id, created: false });
});

test("an older email row is taken over and keeps its code", { skip }, async () => {
  const { rows } = await pool.query(
    "insert into waitlist (email, code) values ('old@example.com', 'ab12cd') returning id",
  );
  const out = await signIn({ did: "did:privy:old", email: "old@example.com" }, { ref: "ffffff" });
  assert.deepEqual(out, { id: rows[0].id, created: false });
  assert.deepEqual(await row(out.id), {
    email: "old@example.com",
    privy_did: "did:privy:old",
    code: "ab12cd",
    referred_by: null,
  });
});

test("a typed-email referrer's code pays nothing until they log in with Privy", { skip }, async () => {
  await pool.query("insert into waitlist (email, code) values ('typed@example.com', 'ee0001')");
  const guest = await signIn({ did: "did:privy:tg", email: "tg@example.com" }, { ref: "ee0001" });
  assert.equal((await loadMember(guest.id)).points, 0);
  await signIn({ did: "did:privy:typed", email: "typed@example.com" });
  assert.equal((await loadMember(guest.id)).points, POINTS.referred);
});

test("a matching ref pays the invitee at signup; self or unknown refs pay nothing", { skip }, async () => {
  const host = await signIn({ did: "did:privy:host", email: "host@example.com" });
  const { code } = await row(host.id);
  const guest = await signIn({ did: "did:privy:guest", email: "guest@example.com" }, { ref: code });
  const body = await loadMember(guest.id);
  assert.equal(body.referred, true);
  assert.equal(body.points, POINTS.referred);
  assert.equal((await loadMember(host.id)).points, 0, "the referrer waits for verification");

  const stray = await signIn({ did: "did:privy:stray", email: "stray@example.com" }, { ref: "nope" });
  assert.equal((await loadMember(stray.id)).points, 0);
});
