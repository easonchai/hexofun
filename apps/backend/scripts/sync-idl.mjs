// Copies target/idl/hex_vault.json into src/idl/ so the backend can require
// it at runtime. Same approach as apps/web/scripts/sync-idl.mjs. Re-run after
// every program rebuild, or via `pnpm --filter @hexvault/backend build`.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const src = resolve(root, "target/idl/hex_vault.json");
const outDir = resolve(here, "../src/idl");
const out = resolve(outDir, "hex_vault.json");

const idl = JSON.parse(readFileSync(src, "utf8"));
if (idl.metadata?.name !== "hex_vault" || typeof idl.address !== "string") {
  throw new Error(`unexpected IDL at ${src}`);
}
// A stale build output must not overwrite the committed IDL.
let committed = [];
try {
  committed = JSON.parse(readFileSync(out, "utf8")).instructions.map((i) => i.name);
} catch {}
const built = new Set(idl.instructions.map((i) => i.name));
const missing = committed.filter((n) => !built.has(n));
if (missing.length) {
  console.error(`${src} lacks ${missing.join(", ")}, which ${out} has. Run \`anchor build\` first.`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
copyFileSync(src, out);
console.log(`synced ${src} -> ${out} (program ${idl.address})`);
