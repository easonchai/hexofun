// Must be the first import: it installs the Node `Buffer` global that the
// Solana packages read while their modules evaluate.
import "./shims/buffer.js";

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AccessGate } from "./AccessGate.js";
import { initAnalytics } from "./analytics.js";
import { App } from "./App.js";
import { CONNECTION_CONFIG, RPC_URL } from "./chain.js";
import { BurnerWalletAdapter, burnerEnabled } from "./dev-burner.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import {
  GameSignerProvider,
  WalletLayer,
  WalletModeProvider,
  walletModeFor,
} from "./wallets.js";

import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";

const ENV: Record<string, string | undefined> = {
  VITE_PRIVY_APP_ID: import.meta.env.VITE_PRIVY_APP_ID as string | undefined,
  VITE_PRIVY_CLIENT_ID: import.meta.env.VITE_PRIVY_CLIENT_ID as
    | string
    | undefined,
  VITE_BURNER_WALLET: import.meta.env.VITE_BURNER_WALLET as string | undefined,
  // The resolved endpoint, not a raw env read: chain.ts is the one place
  // that reads the RPC env var, so every consumer shares one definition.
  VITE_PUBLIC_RPC_URL: RPC_URL,
};

const mode = walletModeFor(ENV, import.meta.env.PROD);

// Dev-only burner wallet: opt-in via env, local RPC only (see dev-burner.ts).
// It augments (never replaces) the standard wallets in the fallback path.
const wallets = burnerEnabled(ENV, import.meta.env.DEV) ? [new BurnerWalletAdapter()] : [];

// No-op without VITE_POSTHOG_KEY (posthog-analytics ticket 02).
initAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <WalletLayer env={ENV}>
        <ConnectionProvider endpoint={RPC_URL} config={CONNECTION_CONFIG}>
          <WalletProvider wallets={wallets} autoConnect>
            <WalletModalProvider>
              <WalletModeProvider mode={mode}>
                <GameSignerProvider>
                  <AccessGate>
                    <App />
                  </AccessGate>
                </GameSignerProvider>
              </WalletModeProvider>
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </WalletLayer>
    </ErrorBoundary>
  </StrictMode>,
);
