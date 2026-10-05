import { QUESTS } from "../_points.js";
import {
  awardReferrals,
  configured,
  ensureSchema,
  loadMember,
  safeParse,
  sessionId,
  sql,
} from "../_lib.js";

/** `https://x.com/<user>/status/<id>` from any x.com or twitter.com post
 *  link, query and trailing path dropped. Null for anything else. */
export function postLink(v) {
  let u;
  try {
    u = new URL(String(v).trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|mobile)\./, "");
  const m = u.pathname.match(/^\/(\w{1,15})\/status\/(\d{1,25})(\/|$)/);
  if (!["x.com", "twitter.com"].includes(host) || !m) return null;
  return `https://x.com/${m[1]}/status/${m[2]}`;
}

/**
 * Claims an honor quest. 401 without a session, 404 for an unknown or
 * non-honor quest, 400 for a `proof` quest without a post link in `url`,
 * 409 until X is connected. A repeat claim writes nothing and still returns
 * 200 with the member body, so the first link stays.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured(res, "DATABASE_URL", "SESSION_SECRET")) return;

  res.setHeader("Cache-Control", "no-store");
  try {
    const id = sessionId(req, process.env.SESSION_SECRET);
    if (!id) return res.status(401).json({ error: "Not signed in" });
    const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
    const quest = QUESTS.find((q) => q.id === body?.id);
    if (quest?.check !== "honor") return res.status(404).json({ error: "No such quest" });
    const proof = quest.proof ? postLink(body.url) : null;
    if (quest.proof && !proof) {
      return res.status(400).json({ error: "Paste the link to your post on X." });
    }

    await ensureSchema();
    const [row] = await sql`select x_user_id from waitlist where id = ${id}::uuid`;
    if (!row) return res.status(401).json({ error: "Not signed in" });
    if (!row.x_user_id) return res.status(409).json({ error: "Connect X first" });
    await sql`
      insert into waitlist_points (waitlist_id, kind, ref, points, proof)
      values (${id}::uuid, 'quest', ${quest.id}, ${quest.points}::int, ${proof})
      on conflict (waitlist_id, kind, ref) do nothing
    `;
    // The follow can verify this member as invitee or referrer, and the like
    // completes the bonus. Pays whatever that unlocks, on either side.
    await awardReferrals(id);
    return res.status(200).json(await loadMember(id));
  } catch (err) {
    console.error("quest claim failed", err);
    return res.status(500).json({ error: "Could not save that. Try again." });
  }
}
