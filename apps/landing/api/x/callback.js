import { awardReferrals, ensureSchema, sessionId, sql } from "../_lib.js";
import { POINTS } from "../_points.js";
import { clearXCookie, identify, readXCookie } from "../_x.js";
import { origin } from "./start.js";

/**
 * Where X sends the browser back. Checks the returned state against the
 * cookie from /start, trades the code (plus PKCE verifier) for the identity,
 * and writes the handle plus the award in one statement. The access token is
 * dropped inside `identify` and never reaches here. Every outcome is a redirect home with
 * `?x=connected|taken|denied|error`.
 */
export default async function handler(req, res) {
  const home = (x) => {
    res.setHeader("Set-Cookie", clearXCookie);
    res.setHeader("Location", `/?x=${x}`);
    return res.status(302).end();
  };

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "no-store");
  // A redirect, not the 500 the other routes send: the visitor is mid-navigation.
  const env = ["DATABASE_URL", "X_CLIENT_ID", "X_CLIENT_SECRET", "SESSION_SECRET"];
  if (!env.every((n) => process.env[n])) {
    console.error("x callback: not configured");
    return home("error");
  }

  const { code, state, error } = req.query ?? {};
  if (error === "access_denied") return home("denied");

  try {
    const id = sessionId(req, process.env.SESSION_SECRET);
    const temp = readXCookie(req, process.env.SESSION_SECRET);
    if (!id || !temp || !code || temp.state !== state) return home("error");

    const { userId, screenName, avatar } = await identify({
      clientId: process.env.X_CLIENT_ID,
      clientSecret: process.env.X_CLIENT_SECRET,
      code,
      redirectUri: `${origin(req)}/api/x/callback`,
      verifier: temp.verifier,
    });

    await ensureSchema();
    // One statement so the handle and its award land together. A second row
    // holding this X account trips the unique key and nothing is written.
    await sql`
      with u as (
        update waitlist
          set x_user_id = ${userId}, x_handle = ${screenName}, x_avatar = ${avatar},
            x_connected_at = now()
          where id = ${id}::uuid
          returning id
      )
      insert into waitlist_points (waitlist_id, kind, ref, points)
      select id, 'x_connect', '', ${POINTS.x_connect}::int from u
      on conflict (waitlist_id, kind, ref) do nothing
    `;
    // X is half of verified; pays whatever that unlocks, on either side.
    await awardReferrals(id);
    return home("connected");
  } catch (err) {
    if (err.constraint === "waitlist_x_user_id_key") return home("taken");
    console.error("x callback failed", err);
    return home("error");
  }
}
