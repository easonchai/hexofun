import {
  awardReferrals,
  configured,
  ensureSchema,
  loadMember,
  safeParse,
  sessionCookie,
  sql,
  str,
  verifyPrivyToken,
  withCode,
} from "../_lib.js";

/**
 * Privy email login. `{ idToken, ref?, referrer?, utm? }` -> verifies the
 * identity token, finds or creates the waitlist row, sets the session cookie
 * and returns the member body plus `created`.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  // JSON only. A cross-site form can post text/plain or urlencoded with no
  // preflight, which would sign the visitor's browser into someone else's row.
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return res.status(415).json({ error: "Expected application/json" });
  }
  if (!configured(res, "DATABASE_URL", "PRIVY_APP_ID", "SESSION_SECRET")) return;

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  if (!body || typeof body.idToken !== "string") {
    return res.status(400).json({ error: "Expected a Privy identity token" });
  }

  try {
    const identity = await verifyPrivyToken(body.idToken, { appId: process.env.PRIVY_APP_ID });
    const { id, created } = await signIn(identity, {
      ref: body.ref,
      referrer: body.referrer,
      utm: body.utm,
      userAgent: req.headers["user-agent"],
    });
    res.setHeader("Set-Cookie", sessionCookie(id, process.env.SESSION_SECRET));
    return res.status(200).json({ ...(await loadMember(id)), created });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("privy sign-in failed", err);
    return res.status(500).json({ error: "Could not sign you in. Try again." });
  }
}

/**
 * The row for a verified identity: by DID, else by email. An email match
 * takes the old row over (typed or Google), keeping its code, referred_by and
 * points. `ref` is stored raw as `referred_by`, never validated, and only on a
 * new row; a matching code pays the invitee's `referred` bonus right away.
 * A takeover runs the referral pass too, since the row has only now joined.
 */
export async function signIn({ did, email }, { ref, referrer, utm, userAgent } = {}) {
  await ensureSchema();
  const known = await sql`select id from waitlist where privy_did = ${did}`;
  if (known.length) return { id: known[0].id, created: false };

  // One statement for both "new" and "seen this email before". xmax is 0 only
  // on a fresh insert.
  const [row] = await withCode(
    (code) => sql`
      insert into waitlist (email, privy_did, code, referred_by, referrer, utm, user_agent)
      values (
        ${email},
        ${did},
        ${code},
        ${str(ref, 16)?.toLowerCase() ?? null},
        ${str(referrer, 500)},
        ${utm && typeof utm === "object" ? JSON.stringify(utm) : null},
        ${str(userAgent, 500)}
      )
      on conflict (email) do update
        set privy_did = coalesce(waitlist.privy_did, excluded.privy_did)
      returning id, (xmax = 0) as created
    `,
  );
  await awardReferrals(row.id);
  return row;
}
