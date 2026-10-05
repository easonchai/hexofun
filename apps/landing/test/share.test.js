import test from "node:test";
import assert from "node:assert/strict";
import { useSql } from "../api/_lib.js";
import card from "../api/card.js";
import { parseCode, parseV, escapeHtml, ogImage, sharePage, cardTree } from "../api/_share.js";

const ORIGIN = "https://hexofun.lol";

test("parseCode lowercases and accepts six hex characters only", () => {
  assert.equal(parseCode("A1b2C3"), "a1b2c3");
  assert.equal(parseCode(["abcdef", "x"]), "abcdef");
  for (const bad of ["abcde", "abcdef0", "abcdeg", "ab cd", "'; drop", "<b>abc", "", undefined, null]) {
    assert.equal(parseCode(bad), null, String(bad));
  }
});

test("parseV keeps digits only", () => {
  assert.equal(parseV("42"), "42");
  assert.equal(parseV("4x2"), null);
  assert.equal(parseV('1"><script>'), null);
  assert.equal(parseV("1790846971155"), "1790846971155");
  assert.equal(parseV("17908469711550"), null);
  assert.equal(parseV(undefined), null);
});

test("ogImage picks the card with a handle and the static image without", () => {
  assert.equal(ogImage(ORIGIN, "abc123", "mo", "7"), `${ORIGIN}/api/card?code=abc123&v=7`);
  assert.equal(ogImage(ORIGIN, "abc123", "mo", null), `${ORIGIN}/api/card?code=abc123`);
  assert.equal(ogImage(ORIGIN, "abc123", null, "7"), `${ORIGIN}/og-image.png`);
});

test("escapeHtml covers the five special characters", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("sharePage carries the tags and redirects to ?ref=", () => {
  const html = sharePage({ origin: ORIGIN, code: "abc123", handle: "mo", v: "7" });
  for (const want of [
    'property="og:title" content="Join @mo on the HEXO.fun waitlist"',
    `property="og:url" content="${ORIGIN}/r/abc123"`,
    `property="og:image" content="${ORIGIN}/api/card?code=abc123&amp;v=7"`,
    'name="twitter:card" content="summary_large_image"',
    'name="twitter:site" content="@Hexofun"',
    `name="twitter:image" content="${ORIGIN}/api/card?code=abc123&amp;v=7"`,
    'location.replace("/?ref=abc123")',
  ]) {
    assert.ok(html.includes(want), want);
  }
  assert.ok(!html.includes("http-equiv"), "no meta refresh, Telegram follows it");
});

test("sharePage escapes a hostile handle and origin", () => {
  const html = sharePage({
    origin: 'https://x"><script>1</script>',
    code: "abc123",
    handle: '"><img src=x onerror=1>',
    v: null,
  });
  assert.ok(!html.includes("<script>1"));
  assert.ok(!html.includes("<img"));
});

test("sharePage uses the static image without a handle", () => {
  const html = sharePage({ origin: ORIGIN, code: "abc123", handle: null, v: "7" });
  assert.ok(html.includes(`content="${ORIGIN}/og-image.png"`));
  assert.ok(!html.includes("/api/card"));
});

const ART = { bg: "data:bg", logo: "data:logo", mark: "data:mark" };

test("cardTree shows the handle, the rank and the avatar, never v", () => {
  const json = JSON.stringify(cardTree({ handle: "mo_x", rank: 12, avatar: "data:face", art: ART }));
  assert.ok(json.includes("@mo_x"));
  assert.ok(json.includes("#12"));
  assert.ok(json.includes("data:face"));
});

test("cardTree draws the handle's first letter without an avatar", () => {
  const json = JSON.stringify(cardTree({ handle: "mo_x", rank: 12, avatar: null, art: ART }));
  assert.ok(json.includes('"children":"M"'));
});

// The route, over a fake client: real ImageResponse, no database.
function run(query, member) {
  useSql(async (strings) => (strings.join("?").includes("ranked") ? member : []));
  process.env.DATABASE_URL = "test";
  const res = {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; },
  };
  return card({ method: "GET", query }, res).then(() => res);
}

test("card route: invalid code, or a row without a handle, goes to the static image", async () => {
  const bad = await run({ code: "nope" }, []);
  assert.equal(bad.code, 302);
  assert.equal(bad.headers.Location, "/og-image.png");
  const none = await run({ code: "abc123" }, [{ code: "abc123", email: "a@b.co", x_handle: null, rank: 3 }]);
  assert.equal(none.code, 302);
});

test("card route: a row with a handle renders a PNG the CDN holds for a minute", async () => {
  // A non-X avatar host is never fetched, so the letter fallback renders offline.
  const res = await run({ code: "abc123", v: "9" }, [
    { code: "abc123", email: "a@b.co", x_handle: "mo", x_avatar: process.env.CARD_AVATAR ?? "https://evil.example/a.png", rank: 3 },
  ]);
  assert.equal(res.code, 200);
  assert.equal(res.headers["Content-Type"], "image/png");
  assert.match(res.headers["Cache-Control"], /s-maxage=60/);
  assert.equal(res.body.subarray(1, 4).toString(), "PNG");
  if (process.env.CARD_OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.CARD_OUT, res.body);
  }
});
