import test from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, loadMember, sessionCookie, useSql } from "../api/_lib.js";
import me from "../api/me.js";
import claim, { postLink } from "../api/quests/claim.js";

// Same harness as points.test.js: needs TEST_DATABASE_URL and pg.
const url = process.env.TEST_DATABASE_URL;
const pg = url ? await import("pg").catch(() => null) : null;
const skip = !pg && "set TEST_DATABASE_URL (and have pg installed) to run";

const schema = `landing_quests_${process.pid}`;
const SECRET = "test-secret";
let pool;

test.before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: "x",
    PRIVY_APP_ID: "x",
    SESSION_SECRET: SECRET,
  });
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

let n = 0;
async function member(x = false) {
  const i = n++;
  const r = await pool.query(
    "insert into waitlist (email, code, x_user_id, privy_did) values ($1, $2, $3, $4) returning id",
    [`q${i}@example.com`, `qq${String(i).padStart(4, "0")}`, x ? `x${i}` : null, `did:q${i}`],
  );
  return r.rows[0].id;
}
async function connectX(id) {
  await pool.query("update waitlist set x_user_id = 'x' || id::text where id = $1", [id]);
  await pool.query(
    "insert into waitlist_points (waitlist_id, kind, points) values ($1, 'x_connect', 10)",
    [id],
  );
}

async function call(handler, { method = "POST", id, body } = {}) {
  const headers = id ? { cookie: `hexo_session=${sessionCookie(id, SECRET).split("=")[1].split(";")[0]}` } : {};
  const out = {};
  const res = {
    setHeader() {},
    status(c) {
      out.status = c;
      return res;
    },
    json(b) {
      out.body = b;
      return res;
    },
  };
  await handler({ method, headers, body }, res);
  return out;
}
const rows = async (id) =>
  (await pool.query("select kind, ref, points from waitlist_points where waitlist_id = $1", [id])).rows;
const quest = (body, id) => body.quests.find((q) => q.id === id);

test("claim writes one row and a repeat writes none", { skip }, async () => {
  const id = await member(true);
  const a = await call(claim, { id, body: { id: "x_follow" } });
  assert.equal(a.status, 200);
  assert.equal(quest(a.body, "x_follow").done, true);
  assert.equal(a.body.points, 10);
  const b = await call(claim, { id, body: { id: "x_follow" } });
  assert.equal(b.status, 200);
  assert.deepEqual(await rows(id), [{ kind: "quest", ref: "x_follow", points: 10 }]);
});

test("claim without X is 409 and writes nothing", { skip }, async () => {
  const id = await member();
  const r = await call(claim, { id, body: { id: "x_follow" } });
  assert.equal(r.status, 409);
  assert.deepEqual(await rows(id), []);
});

test("claim for x_connect or an unknown id is 404", { skip }, async () => {
  const id = await member(true);
  for (const q of ["x_connect", "nope", undefined]) {
    assert.equal((await call(claim, { id, body: { id: q } })).status, 404);
  }
  assert.deepEqual(await rows(id), []);
});

test("claim needs POST and a session", { skip }, async () => {
  assert.equal((await call(claim, { body: { id: "x_follow" } })).status, 401);
  assert.equal((await call(claim, { method: "GET" })).status, 405);
});

test("/me reports done and locked before and after X connect", { skip }, async () => {
  const id = await member();
  const before = (await call(me, { method: "GET", id })).body;
  assert.equal(before.quests.length, 3);
  assert.equal(before.code, null, "the referral code waits for X");
  assert.deepEqual(
    before.quests.map((q) => [q.id, q.done, q.locked]),
    [["x_connect", false, false], ["x_follow", false, true], ["x_like_repost", false, true]],
  );
  await connectX(id);
  await call(claim, { id, body: { id: "x_like_repost", url: "https://x.com/a/status/1" } });
  const after = await loadMember(id);
  assert.deepEqual(
    after.quests.map((q) => [q.id, q.done, q.locked]),
    [["x_connect", true, false], ["x_follow", false, false], ["x_like_repost", true, false]],
  );
  assert.equal(after.points, 30);
  assert.match(after.code, /^qq\d{4}$/);
});

test("postLink keeps x.com and twitter.com post links only", () => {
  const want = "https://x.com/some_one/status/123";
  for (const v of [
    want,
    " https://twitter.com/some_one/status/123?s=20 ",
    "https://mobile.x.com/some_one/status/123/photo/1",
  ]) {
    assert.equal(postLink(v), want);
  }
  for (const v of [
    "",
    undefined,
    "x.com/a/status/1",
    "https://x.com/some_one",
    "https://evil.com/a/status/1",
    "https://x.com.evil.com/a/status/1",
    "https://x.com/a/status/1abc",
  ]) {
    assert.equal(postLink(v), null, String(v));
  }
});

test("like + repost needs a post link and stores it", { skip }, async () => {
  const id = await member(true);
  const bad = await call(claim, { id, body: { id: "x_like_repost", url: "nope" } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await rows(id), []);
  const ok = await call(claim, {
    id,
    body: { id: "x_like_repost", url: "https://twitter.com/me/status/9?s=20" },
  });
  assert.equal(ok.status, 200);
  const { rows: got } = await pool.query(
    "select proof from waitlist_points where waitlist_id = $1 and ref = 'x_like_repost'",
    [id],
  );
  assert.deepEqual(got, [{ proof: "https://x.com/me/status/9" }]);
});
