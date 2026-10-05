import { ensureSchema, loadMemberByCode } from "./_lib.js";
import { parseCode, parseV, sharePage } from "./_share.js";

/** Same origin rule as api/x/start.js. */
const origin = (req) =>
  process.env.PUBLIC_ORIGIN || `https://${req.headers.host}`;

/**
 * Personal link, `/r/<code>` rewritten here by vercel.json. Returns the tags a
 * crawler reads plus a redirect to `/?ref=<code>` for people. A malformed or
 * unknown code goes to `/`. A database failure still serves the page with the
 * static image, since a broken preview beats a broken link.
 */
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const home = () => {
    res.setHeader("Location", "/");
    return res.status(302).end();
  };

  const code = parseCode(req.query?.code);
  if (!code) return home();

  let handle = null;
  if (process.env.DATABASE_URL) {
    try {
      await ensureSchema();
      const member = await loadMemberByCode(code);
      if (!member) return home();
      handle = member.x_handle;
    } catch (err) {
      console.error("share link lookup failed", err);
    }
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Short, so a newly connected handle shows up soon. `v` busts X's own cache.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60");
  return res
    .status(200)
    .send(sharePage({ origin: origin(req), code, handle, v: parseV(req.query?.v) }));
}
