// Must be the first import: it installs the Node `Buffer` global that the
// Solana packages read while their modules evaluate.
import "../shims/buffer.js";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CONNECTION_CONFIG, RPC_URL } from "../chain.js";
import { OpsPage } from "./OpsPage.js";
import { OpsProvider } from "./useOps.js";

import "@solana/wallet-adapter-react-ui/styles.css";
import "../styles.css";
import "./ops.css";

// Plain wallet-adapter only: no Privy, no access gate, no burner, no analytics.
// Wallet-standard wallets (Phantom, Backpack, Ledger via those) register themselves.
document.body.classList.add("ops");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectionProvider endpoint={RPC_URL} config={CONNECTION_CONFIG}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <OpsProvider>
            <OpsPage />
          </OpsProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
);
