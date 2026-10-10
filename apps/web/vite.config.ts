import react from "@vitejs/plugin-react";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";

import { clusterFrom } from "./src/cluster.js";
import { validateProdEnv } from "./src/env.js";

/**
 * Fails the build, not the first page load, on a VITE_CLUSTER typo or a
 * missing production value (ticket 14). A plugin rather than a callback
 * config because vitest.config.ts merges this file, and `mergeConfig`
 * refuses a config in callback form. Vercel hands its variables in through
 * process.env, which loadEnv picks up along with the .env files a local
 * build reads. `vite build` runs in "production" mode unless `--mode`
 * overrides it, which is what "a production build" means here.
 */
const validateCluster: Plugin = {
  name: "hexvault:validate-cluster",
  config(_config, { mode }) {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    clusterFrom(env);
    if (mode === "production") validateProdEnv(env);
  },
};

/**
 * Serves the Ops console's second entry (`ops.html`) at `/ops` on the dev and
 * preview servers, the same mapping vercel.json makes in production.
 */
const opsRoute: Plugin = {
  name: "hexvault:ops-route",
  configureServer(server) {
    server.middlewares.use(rewriteOps);
  },
  configurePreviewServer(server) {
    server.middlewares.use(rewriteOps);
  },
};

const rewriteOps: Connect.NextHandleFunction = (req, _res, next) => {
  if (req.url && /^\/ops(\?|$)/.test(req.url)) {
    req.url = req.url.replace(/^\/ops/, "/ops.html");
  }
  next();
};

/**
 * The Solana packages need the Node `Buffer` global in the browser. `buffer` is
 * already in the pnpm store as a transitive dependency, so alias it there
 * instead of adding a new top-level install.
 */
function bufferPackagePath(): string {
  const store = fileURLToPath(
    new URL("../../node_modules/.pnpm", import.meta.url),
  );
  const entry = readdirSync(store)
    .filter((name) => /^buffer@\d/.test(name))
    .sort()
    .at(-1);
  if (!entry) {
    throw new Error(
      "buffer@* not found in node_modules/.pnpm; run `pnpm install` at the workspace root",
    );
  }
  return fileURLToPath(
    new URL(
      `../../node_modules/.pnpm/${entry}/node_modules/buffer`,
      import.meta.url,
    ),
  );
}

export default defineConfig({
  plugins: [validateCluster, opsRoute, react()],
  resolve: {
    alias: {
      buffer: bufferPackagePath(),
    },
  },
  define: {
    global: "globalThis",
  },
  // Bigint money math and u64 LE encoding need ES2020+.
  build: {
    target: "es2022",
    // Two pages: the player app and the Ops console, each with its own bundle.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        ops: fileURLToPath(new URL("./ops.html", import.meta.url)),
      },
    },
  },
});
