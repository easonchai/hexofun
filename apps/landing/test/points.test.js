import test from "node:test";
import assert from "node:assert/strict";
import { awardReferrals, ensureSchema, loadMember, maskEmail, useSql } from "../api/_lib.js";
import { FOLLOW, LIKE_REPOST, POINTS } from "../api/_points.js";

// Needs a real Postgres: TEST_DATABASE_URL=postgres://... npm test
// It uses `pg`, which the workspace hoists but landing does not declare, and a
// throwaway schema so the database's own tables are never touched. Without
// either, the tests are skipped.
const url = process.env.TEST_DATABASE_URL;
const pg = url ? await import("pg").catch(() => null) : null;
const skip = !pg && "set TEST_DATABASE_URL (and have pg installed) to run";

const schema = `landing_test_${process.pid}`;
let pool;
// Tagged-template client shaped like neon's: resolves to the row array.
const client = (strings, ...vals) =>
  pool.query(strings.reduce((q, s, i) => `${q}$${i}${s}`), vals).then((r) => r.rows);

test.before(async () => {
  if (skip) return;
  const { Pool } = pg.default;
  const admin = new Pool({ connectionString: url });
  await admin.query(`create schema ${schema}`);
  await admin.end();
  pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  useSql(client);
  await ensureSchema();
});

test.after(async () => {
  if (skip) return;
  await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

let n = 0;
async function member({ code, referredBy = null, createdAt = new Date(), x = false, email }) {
  const rows = await pool.query(
    `insert into waitlist (email, code, referred_by, created_at, x_user_id, privy_did)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [email ?? `u${n++}@example.com`, code, referredBy, createdAt, x ? `x${code}` : null, `did:${code}`],
  );
  return rows.rows[0].id;
}
const claim = (id, quest) =>
  pool.query(
    "insert into waitlist_points (waitlist_id, kind, ref, points) values ($1, 'quest', $2, 0)",
    [id, quest],
  );
/** X plus the follow quest, the referral payout's bar on both sides. */
async function verify(id) {
  await pool.query("update waitlist set x_user_id = 'x' || id::text where id = $1", [id]);
  await claim(id, FOLLOW);
}
const awards = async (...ids) =>
  (
    await pool.query(
      `select waitlist_id, kind, ref, points from waitlist_points
       where waitlist_id = any($1) and kind <> 'quest' order by kind, ref`,
      [ids],
    )
  ).rows;

test("the invitee's bonus lands at signup, the referral waits", { skip }, async () => {
  const referrer = await member({ code: "ee0001" });
  const fresh = await member({ code: "ee0002", referredBy: "ee0001", x: true });
  await awardReferrals(fresh);
  assert.deepEqual(await awards(referrer, fresh), [
    { waitlist_id: fresh, kind: "referred", ref: "", points: POINTS.referred },
  ]);
});

test("a verified invitee pays nothing until the referrer is verified", { skip }, async () => {
  const referrer = await member({ code: "aa0001" });
  const fresh = await member({ code: "aa0002", referredBy: "aa0001" });
  await verify(fresh);
  await claim(fresh, LIKE_REPOST);
  await awardReferrals(fresh);
  assert.equal((await awards(referrer)).length, 0);
  const held = await loadMember(referrer);
  assert.equal(held.verified, 1);
  assert.equal(held.referrals, 0);

  await verify(referrer);
  await awardReferrals(referrer);
  await awardReferrals(referrer);
  assert.deepEqual(await awards(referrer), [
    { waitlist_id: referrer, kind: "referral", ref: fresh, points: POINTS.referral },
  ]);
  assert.equal((await loadMember(referrer)).referrals, 1);
});

test("a referrer verified first is paid when the invitee verifies", { skip }, async () => {
  const referrer = await member({ code: "hh0001" });
  await verify(referrer);
  const fresh = await member({ code: "hh0002", referredBy: "hh0001", x: true });
  await awardReferrals(fresh);
  assert.equal((await awards(referrer)).length, 0, "X alone is not verified");
  await claim(fresh, FOLLOW);
  await awardReferrals(fresh);
  assert.deepEqual((await awards(referrer)).map((a) => a.kind), ["referral"]);
  await claim(fresh, LIKE_REPOST);
  await awardReferrals(fresh);
  assert.deepEqual(
    (await awards(referrer)).map((a) => a.kind),
    ["referral"],
    "the like + repost pays no referral bonus",
  );
});

test("self-referral earns nothing", { skip }, async () => {
  const me = await member({ code: "ff0001", referredBy: "ff0001" });
  await verify(me);
  await awardReferrals(me);
  assert.deepEqual(await awards(me), []);
  assert.equal((await loadMember(me)).referred, false);
});

test("an unknown referrer code writes nothing", { skip }, async () => {
  const fresh = await member({ code: "bb0001", referredBy: "nobody" });
  await awardReferrals(fresh);
  assert.deepEqual(await awards(fresh), []);
});

test("the backfill credits old referrals once", { skip }, async () => {
  const referrer = await member({ code: "cc0001" });
  await verify(referrer);
  await verify(await member({ code: "cc0002", referredBy: "cc0001" }));
  await verify(await member({ code: "cc0003", referredBy: "cc0001" }));
  await awardReferrals();
  assert.equal((await awards(referrer)).length, 2);
  await awardReferrals();
  useSql(client); // resets the cached schema check so ensureSchema reruns
  await ensureSchema();
  assert.equal((await awards(referrer)).length, 2);
  assert.equal((await loadMember(referrer)).referrals, 2);
});

test("equal points rank the earlier signup first, and next_gap passes the row above", { skip }, async () => {
  const day = (d) => new Date(Date.UTC(2020, 0, d));
  const later = await member({ code: "dd0002", createdAt: day(2) });
  const earlier = await member({ code: "dd0001", createdAt: day(1) });
  const a = await loadMember(earlier);
  const b = await loadMember(later);
  assert.equal(a.points, b.points);
  assert.equal(b.rank, a.rank + 1);
  assert.equal(b.next_gap, 1, "a tie loses to the earlier signup");
  await pool.query(
    "insert into waitlist_points (waitlist_id, kind, ref, points) values ($1, 'adjust', '', 7)",
    [earlier],
  );
  assert.equal((await loadMember(later)).next_gap, 8);
});

test("rank 1 has no next_gap", { skip }, async () => {
  const top = await member({ code: "ii0001" });
  await pool.query(
    "insert into waitlist_points (waitlist_id, kind, ref, points) values ($1, 'adjust', '', 100000)",
    [top],
  );
  const body = await loadMember(top);
  assert.equal(body.rank, 1);
  assert.equal(body.next_gap, null);
});

test("name is the handle, else the masked email, and the email never leaves", { skip }, async () => {
  const id = await member({ code: "jj0001", email: "satoshi@gmx.net" });
  const body = await loadMember(id);
  assert.equal(body.name, "sa***@gmx.net");
  assert.equal(body.email, undefined);
  await pool.query("update waitlist set x_handle = 'sato' where id = $1", [id]);
  assert.equal((await loadMember(id)).name, "@sato");
});

test("maskEmail keeps two characters at most", () => {
  assert.equal(maskEmail("a@b.co"), "a***@b.co");
  assert.equal(maskEmail("abcdef@b.co"), "ab***@b.co");
});
