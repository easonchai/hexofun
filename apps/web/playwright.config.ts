import { defineConfig, devices } from "playwright/test";

/**
 * Ticket 12 (deploy) has not landed a live URL yet. See 13's ticket file.
 * Until it does, this boots its own Vite dev servers on ports of their own
 * (not :5173, which a hand-run `pnpm dev` owns). The moment a Vercel URL
 * exists, point E2E_BASE_URL at it and nothing here changes.
 *
 * Vite inlines VITE_* at build time, and two specs disagree on the game gate,
 * so there are two servers: the default one has the burner wallet on a local
 * RPC and the gate unset; `gated` (earn-play-gate) is the same with
 * VITE_GATE_GAME=off. Neither the API nor the RPC is started: each spec
 * answers them with page.route, or skips when it needs a live stack.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5196";
const gatedURL = process.env.E2E_GATED_BASE_URL ?? "http://127.0.0.1:5197";
const isLocal = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);

const burnerEnv = {
  VITE_BURNER_WALLET: "1",
  VITE_PUBLIC_RPC_URL: "http://127.0.0.1:8899",
  VITE_API_URL: "http://127.0.0.1:8080",
  VITE_PRIVY_APP_ID: "off",
  // Blank wins over a checkout's .env/.env.local and reads as unset, so the
  // mocks' Pool (IDL program, pool 1, devnet) matches and analytics stay off.
  VITE_PROGRAM_ID: "",
  VITE_POOL_ID: "",
  VITE_CLUSTER: "",
  VITE_POSTHOG_KEY: "",
};

// Bind the host the URL names: Playwright polls that host, and Vite's default
// (`localhost`) can bind ::1 only, so the poll never connects.
function devServer(url: string, env: Record<string, string>) {
  const { hostname, port } = new URL(url);
  return {
    command: `pnpm exec vite --host ${hostname} --port ${port} --strictPort`,
    url,
    env,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  };
}

export default defineConfig({
  testDir: "./e2e",
  // A round is 90s by default (spec.md §7) and the flow waits out one full
  // round plus settlement, so the per-test budget has to clear that.
  timeout: 210_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  // ponytail: only auto-boot the dev servers for the local default targets.
  // Pointing E2E_BASE_URL at a deployed environment (Vercel, once ticket 12
  // lands) skips them. There is nothing to start, and nothing to
  // accidentally spin up against a URL that's already live.
  webServer: [
    ...(isLocal(baseURL) ? [devServer(baseURL, burnerEnv)] : []),
    ...(isLocal(gatedURL) ? [devServer(gatedURL, { ...burnerEnv, VITE_GATE_GAME: "off" })] : []),
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // Anything named *.phone.spec.ts is phone-only; keep it off desktop.
      testIgnore: ["**/*.phone.spec.ts", "**/earn-play-gate.spec.ts"],
    },
    {
      // The game gate is a build-time flag, so this spec needs the gated server.
      name: "gated",
      use: { ...devices["Desktop Chrome"], baseURL: gatedURL },
      testMatch: "**/earn-play-gate.spec.ts",
    },
    {
      // iPhone 13: 390px wide, WebKit. Run `pnpm exec playwright install
      // webkit` once locally before this project can launch a browser.
      name: "phone",
      use: { ...devices["iPhone 13"] },
      testMatch: "**/*.phone.spec.ts",
    },
  ],
});
