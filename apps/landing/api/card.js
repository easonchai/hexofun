import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { configured, ensureSchema, loadMemberByCode } from "./_lib.js";
import { cardTree, parseCode } from "./_share.js";

// Node runtime. satori plus resvg-wasm rather than @vercel/og: its Node build
// is a bundle that calls require("fs") and __dirname from inside an ES module,
// which throws in a "type": "module" package. Both files below are read by
// literal path so Vercel's file tracing ships them with the function.
const require = createRequire(import.meta.url);
const FONT = readFileSync(new URL("./_fonts/Syncopate-Bold.ttf", import.meta.url));
const MONO = readFileSync(new URL("./_fonts/RobotoMono-Regular.woff", import.meta.url));
const png = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
// Exported from Figma 540:45456: texture plus glows, the logo, the line + star.
const ART = {
  bg: png(readFileSync(new URL("./_card/bg.png", import.meta.url))),
  logo: png(readFileSync(new URL("./_card/logo.png", import.meta.url))),
  mark: png(readFileSync(new URL("./_card/mark.png", import.meta.url))),
};

/** The stored X avatar as a data URI, or null so the card draws a letter.
 *  Only X's CDN (parseAvatar checked it on the way in), three seconds, and
 *  only the formats satori decodes. */
async function fetchAvatar(url) {
  if (!url?.startsWith("https://pbs.twimg.com/")) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(jpeg|png)$/.test(type)) return null;
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch (err) {
    console.error("avatar fetch failed", err);
    return null;
  }
}

let wasm;
const ready = () =>
  (wasm ??= initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm"))).catch(
    (err) => {
      wasm = undefined;
      throw err;
    },
  ));

/** The card as PNG bytes. */
async function render(member) {
  await ready();
  const avatar = await fetchAvatar(member.x_avatar);
  const svg = await satori(cardTree({ handle: member.x_handle, rank: member.rank, avatar, art: ART }), {
    width: 1200,
    height: 630,
    fonts: [
      { name: "Syncopate", data: FONT, weight: 700, style: "normal" },
      { name: "Roboto Mono", data: MONO, weight: 400, style: "normal" },
    ],
  });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
}

/**
 * The share card, 1200x630. Handle, avatar and rank come from the row at
 * render time. The CDN holds each URL for a minute, so a loop on one link
 * costs one render. `v` (the share's timestamp) is only part of the URL so
 * each share is a new URL, for X's cache and ours. It is never read. A code
 * with no X handle goes to the static image.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const staticImage = () => {
    res.setHeader("Location", "/og-image.png");
    return res.status(302).end();
  };

  const code = parseCode(req.query?.code);
  if (!code) return staticImage();
  if (!configured(res, "DATABASE_URL")) return;

  try {
    await ensureSchema();
    const member = await loadMemberByCode(code);
    if (!member?.x_handle) return staticImage();

    const png = await render(member);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60");
    return res.status(200).send(png);
  } catch (err) {
    console.error("card failed", err);
    return res.status(500).json({ error: "Could not render that. Try again." });
  }
}
