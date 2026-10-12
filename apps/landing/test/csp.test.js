import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

// vercel.json is static, so an edited inline script silently fails the CSP
// until its hash there is updated by hand. This catches it before deploy.
test("vercel.json CSP allows every inline script in index.html", async () => {
  const html = await read("index.html");
  const { headers } = JSON.parse(await read("vercel.json"));
  const csp = headers[0].headers.find((h) => h.key.startsWith("Content-Security-Policy-")).value;
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    ([, body]) => `'sha256-${createHash("sha256").update(body).digest("base64")}'`,
  );
  assert.ok(hashes.length > 0);
  for (const h of hashes) assert.ok(csp.includes(h), `add ${h} to script-src in vercel.json`);
});
