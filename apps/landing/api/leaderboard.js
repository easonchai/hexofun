import { configured, ensureSchema, loadLeaderboard } from "./_lib.js";

/** Public top 100 as `[{ rank, name, points }]`. No session, no email. */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!configured(res, "DATABASE_URL")) return;

  try {
    await ensureSchema();
    const rows = await loadLeaderboard();
    res.setHeader("Cache-Control", "public, s-maxage=30");
    return res.status(200).json(rows);
  } catch (err) {
    console.error("leaderboard failed", err);
    return res.status(500).json({ error: "Could not load that. Try again." });
  }
}
