import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { FOLLOW, POINTS, QUESTS } from "./_points.js";

/**
 * Shared by the routes. Files that start with `_` are not routes on Vercel.
 * Every export is inert at import time: no env reads, no connections.
 */

// Built on first query so tests can import this file without DATABASE_URL.
let client;
export const sql = (...args) => (client ??= neon(process.env.DATABASE_URL))(...args);

/** Tests swap in a tagged-template client over node-postgres, since neon's
 *  driver needs its HTTP endpoint. Resets the schema check for the new DB. */
export function useSql(fn) {
  client = fn;
  ready = undefined;
}

const CODE_ATTEMPTS = 5;

let ready;

/** Idempotent DDL instead of a migration step for a single table. Later
 *  columns are `add column if not exists` so the same code runs against a
 *  table created by any earlier version. */
export function ensureSchema() {
  ready ??= (async () => {
    await sql`
      create table if not exists waitlist (
        id          uuid primary key default gen_random_uuid(),
        email       text not null unique,
        answer      text,
        referrer    text,
        utm         jsonb,
        user_agent  text,
        created_at  timestamptz not null default now(),
        answered_at timestamptz
      )
    `;
    await sql`alter table waitlist add column if not exists code text unique`;
    await sql`alter table waitlist add column if not exists referred_by text`;
    await sql`alter table waitlist add column if not exists x_user_id text unique`;
    await sql`alter table waitlist add column if not exists x_handle text`;
    await sql`alter table waitlist add column if not exists x_connected_at timestamptz`;
    await sql`alter table waitlist add column if not exists x_avatar text`;
    await sql`alter table waitlist add column if not exists privy_did text unique`;
    // Backfill signups from before codes existed. Empty after the first run.
    const missing = await sql`select id from waitlist where code is null`;
    for (const { id } of missing) {
      await withCode(
        (code) => sql`update waitlist set code = ${code} where id = ${id}::uuid`,
      );
    }
    await sql`
      create table if not exists waitlist_points (
        id          bigserial primary key,
        waitlist_id uuid not null references waitlist(id),
        kind        text not null,
        ref         text not null default '',
        points      int not null,
        created_at  timestamptz not null default now(),
        unique (waitlist_id, kind, ref)
      )
    `;
    await sql`alter table waitlist_points add column if not exists proof text`;
    await awardReferrals();
  })().catch((err) => {
    ready = undefined; // let the next request retry rather than cache a failure
    throw err;
  });
  return ready;
}

export const newCode = () => randomBytes(3).toString("hex");

/** Runs `write` with a fresh code, drawing again on a code collision. 16.7M
 *  codes, so a second draw is rare and a fifth is a bug elsewhere. */
export async function withCode(write) {
  for (let i = 0; ; i++) {
    try {
      return await write(newCode());
    } catch (err) {
      if (err.constraint !== "waitlist_code_key" || i + 1 >= CODE_ATTEMPTS) {
        throw err;
      }
    }
  }
}

export function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function str(v, max) {
  return typeof v === "string" && v ? v.slice(0, max) : null;
}

/** The body every signed-in response returns. Later tickets add fields here,
 *  and the routes stay unchanged. Rank is position by total points descending,
 *  then earlier signup, then id so it is always a strict order.
 *
 *  Only rows with a `privy_did` have joined. Rows from the typed-email form
 *  stay in the table so a Privy login with the same email can take them over,
 *  but until then they have no rank, no board slot and no referral pay. */
export const loadMember = (id) => loadMemberWhere(id, null);

/** The same body by share code, for the public card and link routes. */
export const loadMemberByCode = (code) => loadMemberWhere(null, code);

async function loadMemberWhere(id, code) {
  // ponytail: window function over every row on each call, fine at waitlist
  // size. When it shows in latency, cache the ranking for a few seconds or
  // keep a materialised total per row.
  const rows = await sql`
    with ranked as (
      select
        w.id,
        coalesce(sum(p.points), 0)::int as points,
        (count(p.id) filter (where p.kind = 'referral'))::int as referrals,
        (row_number() over board)::int as rank,
        (lag(coalesce(sum(p.points), 0)) over board)::int as above
      from waitlist w
      left join waitlist_points p on p.waitlist_id = w.id
      where w.privy_did is not null
      group by w.id
      window board as (order by coalesce(sum(p.points), 0) desc, w.created_at asc, w.id asc)
    ),
    invitees as (
      select
        (i.x_user_id is not null and exists (
          select 1 from waitlist_points p
          where p.waitlist_id = i.id and p.kind = 'quest' and p.ref = ${FOLLOW}
        )) as verified
      from waitlist i
      join waitlist w on w.code = i.referred_by and w.id <> i.id
      where i.privy_did is not null and (w.id = ${id}::uuid or w.code = ${code})
    )
    select w.id, w.code, w.email, w.x_handle, w.x_avatar, r.rank, r.points, r.referrals, r.above,
      (select count(*) filter (where verified) from invitees)::int as verified,
      (w.x_user_id is not null) as x,
      array(
        select p.kind || ':' || p.ref from waitlist_points p
        where p.waitlist_id = w.id and p.kind in ('quest', 'x_connect', 'referred')
      ) as got
    from waitlist w
    join ranked r on r.id = w.id
    where w.id = ${id}::uuid or w.code = ${code}
  `;
  if (!rows[0]) return null;
  // Quest state rides along as `x` and `got`, and stays out of the body, as
  // does the email: only its masked form leaves the server.
  const { x, got = [], email, above, ...member } = rows[0];
  const quests = QUESTS.map((q) => ({
    ...q,
    done: got.includes(q.check === "oauth" ? `${q.id}:` : `quest:${q.id}`),
    locked: q.check !== "oauth" && !x,
  }));
  return {
    ...member,
    name: displayName(member.x_handle, email),
    // The referral link unlocks with X, so the code stays here until then.
    code: x ? member.code : null,
    // Ties go to the earlier signup, so passing the row above takes one more point.
    next_gap: above == null ? null : above - member.points + 1,
    referred: got.includes("referred:"),
    // The page labels the referral rows with these, so they live in one place.
    rates: { referred: POINTS.referred, referral: POINTS.referral },
    quests,
  };
}

/** `ab***@domain` from `abcdef@domain`. Shows on the public board, so it
 *  never includes more than two characters of the local part. */
export function maskEmail(email) {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

const displayName = (handle, email) => (handle ? `@${handle}` : maskEmail(email));

/** Top 100 for the public board. Same order as the rank in `loadMemberWhere`
 *  (points, then earlier signup, then id). Not shared as SQL, since a tagged
 *  template cannot splice a fragment; a test pins the two together. */
export async function loadLeaderboard() {
  const rows = await sql`
    select
      (row_number() over (
        order by coalesce(sum(p.points), 0) desc, w.created_at asc, w.id asc
      ))::int as rank,
      w.x_handle, w.email,
      coalesce(sum(p.points), 0)::int as points
    from waitlist w
    left join waitlist_points p on p.waitlist_id = w.id
    where w.privy_did is not null
    group by w.id
    order by rank
    limit 100
  `;
  return rows.map(({ rank, x_handle, email, points }) => ({
    rank,
    name: displayName(x_handle, email),
    points,
  }));
}

/** Every referral award, for the pairs where `id` is the invitee or the
 *  referrer; with no id, every pair. The invitee's `referred` bonus is paid as
 *  soon as the code matches. The referrer's `referral` waits until both sides
 *  are verified (X plus the follow quest). Safe to repeat, the unique key drops the
 *  second insert, so a held-back award lands on whichever call comes first. */
export function awardReferrals(id = null) {
  return sql`
    with v as (
      select w.id, w.code, w.referred_by,
        (w.x_user_id is not null and exists (
          select 1 from waitlist_points p
          where p.waitlist_id = w.id and p.kind = 'quest' and p.ref = ${FOLLOW}
        )) as verified
      from waitlist w
      where w.privy_did is not null
    ),
    q as (
      select r.id as referrer, i.id as invitee, r.verified and i.verified as paid
      from v i
      join v r on r.code = i.referred_by and r.id <> i.id
      where ${id}::uuid is null or i.id = ${id}::uuid or r.id = ${id}::uuid
    )
    insert into waitlist_points (waitlist_id, kind, ref, points)
    select invitee, 'referred', '', ${POINTS.referred}::int from q
    union all
    select referrer, 'referral', invitee::text, ${POINTS.referral}::int from q where paid
    on conflict (waitlist_id, kind, ref) do nothing
  `;
}

/** Sends the 500 and returns false when an env var is missing. */
export function configured(res, ...names) {
  if (names.every((n) => process.env[n])) return true;
  res.status(500).json({ error: "Not configured" });
  return false;
}

// ------------------------------- session ---------------------------------
// Cookie value is `<waitlist id>.<hex HMAC-SHA256 of the id>`.

export const SESSION_COOKIE = "hexo_session";

const mac = (id, secret) => createHmac("sha256", secret).update(id).digest("hex");

export const signSession = (id, secret) => `${id}.${mac(id, secret)}`;

/** The id inside a signed value, or null when the value was not signed by us. */
export function verifySession(value, secret) {
  if (typeof value !== "string") return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;
  const id = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(mac(id, secret));
  // timingSafeEqual throws on unequal lengths, so compare those first.
  return got.length === want.length && timingSafeEqual(got, want) ? id : null;
}

export const sessionCookie = (id, secret) =>
  `${SESSION_COOKIE}=${signSession(id, secret)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** One cookie's raw value from a request's Cookie header, or undefined. */
export function getCookie(req, name) {
  const raw = String(req.headers.cookie ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`));
  return raw?.slice(name.length + 1);
}

/** The signed-in waitlist id from a request's Cookie header, or null. */
export function sessionId(req, secret) {
  return verifySession(getCookie(req, SESSION_COOKIE), secret);
}

// -------------------------------- privy ----------------------------------

let privyKeys;

/** Checks a Privy identity token and returns `{ did, email }`. `keySet` is a
 *  jose key resolver; tests pass a local one, production takes the app's JWKS
 *  with a five second fetch timeout. Privy only links an email after its code
 *  is confirmed, and a Google account's email is Google-verified, so either is
 *  a verified one; a typed email wins when both are linked. Errors carry the
 *  HTTP `status` to answer with. */
export async function verifyPrivyToken(idToken, { appId, keySet }) {
  keySet ??= privyKeys ??= createRemoteJWKSet(
    new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`),
    { timeoutDuration: 5000 },
  );
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet, {
      issuer: "privy.io",
      audience: appId,
      algorithms: ["ES256"],
    }));
  } catch (cause) {
    throw Object.assign(new Error("Sign-in failed", { cause }), { status: 401 });
  }
  // The claim is a JSON string in Privy's tokens; accept an array as well.
  const raw = payload.linked_accounts;
  const accounts = typeof raw === "string" ? (safeParse(raw) ?? []) : (raw ?? []);
  const list = Array.isArray(accounts) ? accounts : [];
  const email =
    list.find((a) => a?.type === "email" && typeof a.address === "string")?.address ??
    list.find((a) => a?.type === "google_oauth" && typeof a.email === "string")?.email;
  if (!email || !payload.sub) {
    throw Object.assign(new Error("Sign in with email or Google"), { status: 400 });
  }
  return { did: payload.sub, email: email.toLowerCase() };
}
