// Bundles src/privy.jsx into ./privy/ (entry privy/privy.js plus chunks). Run by `npm run build` (Vercel runs
// it on deploy) and by dev.js in watch mode. PRIVY_APP_ID is inlined: it is
// public, the same id apps/web ships.
import * as esbuild from "esbuild";

export const options = () => {
  if (!process.env.PRIVY_APP_ID) throw new Error("PRIVY_APP_ID is not set");
  return {
    entryPoints: [new URL("./src/privy.jsx", import.meta.url).pathname],
    outdir: new URL("./privy", import.meta.url).pathname,
    splitting: true,
    chunkNames: "[hash]",
    bundle: true,
    format: "esm",
    minify: true,
    jsx: "automatic",
    target: "es2020",
    define: {
      PRIVY_APP_ID: JSON.stringify(process.env.PRIVY_APP_ID),
      "process.env.NODE_ENV": '"production"',
      global: "globalThis",
    },
    logLevel: "warning",
  };
};

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  await esbuild.build(options());
}
