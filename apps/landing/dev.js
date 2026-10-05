// Local dev server: static files plus the api/ routes, without Vercel.
// A plain postgres:// DATABASE_URL goes through `pg` (hoisted from the root),
// since neon's driver only speaks HTTP to Neon. A Neon URL is left alone.
//
//   node --env-file=.env.local dev.js        # http://localhost:3000
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { parseEnv } from "node:util";
import { useSql } from "./api/_lib.js";

const ROOT = import.meta.dirname;
// .env.local wins over the shell, unlike --env-file, so a DATABASE_URL
// exported for the backend doesn't leak in.
try {
  Object.assign(process.env, parseEnv(await readFile(join(ROOT, ".env.local"), "utf8")));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

// Rebuilds privy/ on change, the same bundle `npm run build` makes for Vercel.
const esbuild = await import("esbuild");
const { options } = await import("./build.js");
await (await esbuild.context(options())).watch();

const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".js": "text/javascript",
};

const db = process.env.DATABASE_URL;
if (db && !db.includes("neon.tech")) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: db });
  pool.on("error", (err) => console.error("postgres:", err.message));
  // Same neon-shaped tagged-template client as test/points.test.js.
  useSql((strings, ...vals) =>
    pool.query(strings.reduce((q, s, i) => `${q}$${i}${s}`), vals).then((r) => r.rows),
  );
}

// The slice of Vercel's res helpers the routes use.
function shim(res) {
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  res.send = (body) => res.end(body);
  return res;
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  try {
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return raw;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // vercel.json rewrite.
  const r = url.pathname.match(/^\/r\/([^/]+)$/);
  if (r) {
    url.pathname = "/api/r";
    url.searchParams.set("code", r[1]);
  }

  try {
    if (url.pathname.startsWith("/api/")) {
      const file = join(ROOT, normalize(url.pathname) + ".js");
      if (/\/_/.test(url.pathname)) throw Object.assign(new Error(), { code: "ENOENT" });
      const { default: handler } = await import(file);
      req.query = Object.fromEntries(url.searchParams);
      req.body = await body(req);
      return await handler(req, shim(res));
    }
    const path = url.pathname === "/" ? "/index.html" : normalize(url.pathname);
    const data = await readFile(join(ROOT, path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ERR_MODULE_NOT_FOUND") {
      res.writeHead(404).end("Not found");
    } else {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end("Server error");
    }
  }
}).listen(PORT, () => console.log(`landing on http://localhost:${PORT}`));
