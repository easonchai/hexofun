/**
 * Pure pieces of the personal link (/r/<code>) and its card. No I/O, so the
 * tests import this file directly. Files that start with `_` are not routes.
 */

const CODE = /^[0-9a-f]{6}$/;

/** A share code as lowercase hex, or null. Everything downstream (SQL, HTML,
 *  URLs) only ever sees the return value of this. */
export function parseCode(raw) {
  const code = String(Array.isArray(raw) ? raw[0] : (raw ?? "")).toLowerCase();
  return CODE.test(code) ? code : null;
}

/** The `v` cache key (a share's timestamp in ms) as digits only, or null.
 *  Never shown on the card. */
export function parseV(raw) {
  const v = String(Array.isArray(raw) ? raw[0] : (raw ?? ""));
  return /^[0-9]{1,13}$/.test(v) ? v : null;
}

export const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** The card for a member with X connected, the static image otherwise. */
export function ogImage(origin, code, handle, v) {
  if (!handle) return `${origin}/og-image.png`;
  const q = `code=${code}` + (v ? `&v=${v}` : "");
  return `${origin}/api/card?${q}`;
}

/** The small document crawlers read. People get sent on to `/?ref=<code>`,
 *  which is where the referral is credited. Every interpolation is escaped.
 *  The redirect is JS only: Telegram's crawler follows a meta refresh and
 *  would read the landing page's tags instead of these. */
export function sharePage({ origin, code, handle, v }) {
  const e = escapeHtml;
  const title = handle
    ? `Join @${handle} on the HEXO.fun waitlist`
    : "Join the waitlist. Earn 5%, play for jackpot.";
  const desc =
    "A no-loss savings app on Solana. Your deposit earns 5% and never goes into the game. Every dollar is a ticket in the daily jackpot.";
  const image = ogImage(origin, code, handle, v);
  const target = `/?ref=${code}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${e(title)}</title>
<meta property="og:type" content="website" />
<meta property="og:site_name" content="HEXO.fun" />
<meta property="og:title" content="${e(title)}" />
<meta property="og:description" content="${e(desc)}" />
<meta property="og:url" content="${e(`${origin}/r/${code}`)}" />
<meta property="og:image" content="${e(image)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:site" content="@Hexofun" />
<meta name="twitter:title" content="${e(title)}" />
<meta name="twitter:description" content="${e(desc)}" />
<meta name="twitter:image" content="${e(image)}" />
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body><a href="${e(target)}">HEXO.fun</a></body>
</html>
`;
}

// Landing palette (index.html :root).
const NAVY = "#0e1b2b";
const NAVY_700 = "#132133";
const LIME = "#b6ff3b";

const el = (type, style, children) => ({ type, props: { style, children } });
const img = (src, style) => ({ type: "img", props: { src, style } });
const at = (left, top, style = {}) => ({ position: "absolute", left, top, display: "flex", ...style });

/**
 * Element tree for satori, 1200x630. Plain objects, no JSX. Figma's
 * "Waitlist Ladder Template" (540:45456) is 1200x670; X shows 1.91:1, so the
 * layout is that frame with 20px trimmed off the top and bottom.
 * `art` holds the background, logo and mark as data URIs; `avatar` is one too,
 * or null, which draws the handle's first letter instead.
 */
export function cardTree({ handle, rank, avatar, art }) {
  const label = `#${rank}`;
  // Syncopate digits run about 0.76em wide; keep the rank clear of the avatar.
  const rankSize = Math.min(200, Math.floor(720 / (label.length * 0.76)));
  const face = avatar
    ? img(avatar, { width: 276, height: 276, borderRadius: 34, objectFit: "cover" })
    : el(
        "div",
        {
          width: 276,
          height: 276,
          borderRadius: 34,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: NAVY_700,
          color: LIME,
          fontSize: 140,
        },
        handle.slice(0, 1).toUpperCase(),
      );
  return el(
    "div",
    { width: 1200, height: 630, display: "flex", position: "relative", background: NAVY, fontFamily: "Syncopate" },
    [
      img(art.bg, at(0, -20, { width: 1200, height: 670 })),
      img(art.logo, at(64, 44, { width: 162, height: 47.5 })),
      el("div", at(64, 154, { fontSize: rankSize, lineHeight: 1.1, letterSpacing: 2.8, color: LIME }), label),
      el("div", at(64, 383, { flexDirection: "column", fontSize: 32, lineHeight: "40px", letterSpacing: 0.88, color: "#fff" }), [
        el("div", { display: "flex" }, [
          // Satori trims a trailing plain space at a span edge.
          el("span", {}, "On the "),
          el("span", { color: LIME }, "HEXO"),
        ]),
        el("div", { display: "flex" }, "Waitlist Ladder"),
      ]),
      el("div", at(823, 160), [face]),
      el(
        "div",
        at(803, 452, {
          width: 316,
          justifyContent: "center",
          fontFamily: "Roboto Mono",
          fontSize: 22.4,
          letterSpacing: 2.6,
          color: "#fff",
        }),
        `@${handle}`,
      ),
      el("div", at(64, 557, { fontSize: 16, lineHeight: "52px", letterSpacing: 0.3, color: LIME }), "A no-loss savings app"),
      img(art.mark, at(1001, 566, { width: 135, height: 22.5 })),
    ],
  );
}
