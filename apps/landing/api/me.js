import { configured, ensureSchema, loadMember, sessionId } from "./_lib.js";

/**
 * Who is signed in. 200 with the member body, or 401 without a valid cookie.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured(res, "DATABASE_URL", "SESSION_SECRET")) return;

  res.setHeader("Cache-Control", "no-store");
  try {
    const id = sessionId(req, process.env.SESSION_SECRET);
    if (id) {
      await ensureSchema();
      const member = await loadMember(id);
      if (member) return res.status(200).json(member);
    }
    return res.status(401).json({ error: "Not signed in" });
  } catch (err) {
    console.error("me failed", err);
    return res.status(500).json({ error: "Could not load that. Try again." });
  }
}
