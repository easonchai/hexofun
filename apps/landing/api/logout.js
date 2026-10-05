import { clearSessionCookie } from "./_lib.js";

/** Clears the session cookie. The page logs out of Privy itself. */
export default function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Set-Cookie", clearSessionCookie);
  return res.status(204).end();
}
