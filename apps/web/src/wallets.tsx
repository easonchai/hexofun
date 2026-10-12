/**
 * Wallet layer: Privy is the primary connection path (VITE_PRIVY_APP_ID);
 * standard injected Solana wallets are the fallback when no App ID is
 * configured. Both modes reduce to one interface the app consumes:
 * publicKey + signTransaction, which is all AnchorProvider needs.
 */
import { PrivyProvider, useLogin, useLogout } from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useSignAndSendTransaction,
  useSignMessage,
  useSignTransaction,
  useWallets,
} from "@privy-io/react-auth/solana";
import { utils as anchorUtils } from "@anchor-lang/core";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type PublicKey as PubkeyType,
} from "@solana/web3.js";

import { identifyWallet, resetIdentity, track } from "./analytics.js";
import { CLUSTER, RPC_URL, SIGNING_CHAIN } from "./chain.js";
import type { SignInInput, SignInOutput } from "./session.js";

export type WalletMode = "privy" | "standard";

export interface GameSigner {
  mode: WalletMode;
  publicKey: PubkeyType | undefined;
  /**
   * False while last session's wallet is still being restored (Privy's
   * `ready`, wallet-adapter's `connecting`). `connected` is false during that
   * window too, so anything that reacts to "not connected" (the invite gate)
   * waits on this instead of flashing.
   */
  ready: boolean;
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  signTransaction:
    | (<T extends Transaction | VersionedTransaction>(
        transaction: T,
      ) => Promise<T>)
    | undefined;
  /**
   * Signs an arbitrary message, not a transaction. Ticket 09's invite gate is
   * the one caller so far, signing `HEXO access: <wallet> <CODE>` for
   * `POST /access/redeem`. Unset until a wallet is connected.
   */
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
  /**
   * Sign In With Solana, for wallets whose adapter offers it (Phantom and
   * Solflare through wallet-standard). The session delegation prefers it over
   * `signMessage`. Unset for Privy and the dev burner.
   */
  signIn?: ((input: SignInInput) => Promise<SignInOutput>) | undefined;
  /**
   * Signs, sends and confirms in one step, returning the base58 signature.
   * Set only for the Privy embedded wallet, where Privy's own send path is
   * the one that applies dashboard gas sponsorship: a signed-then-broadcast
   * transaction keeps the user as fee payer and fails on an empty wallet.
   * External wallets and the dev burner leave it unset and go through
   * Anchor's sign-and-broadcast, which pays fees from the user's SOL.
   */
  sendTransaction?: ((transaction: Transaction) => Promise<string>) | undefined;
}

/**
 * Public Privy application id. Privy app ids are publishable client
 * identifiers (they ship in the bundle by design), so a dev fallback is safe
 * to keep in source — but ticket 14 drops it in a production build: a
 * forgotten env var must not silently ship someone else's Privy app. Set
 * VITE_PRIVY_APP_ID="" (or "off") to explicitly disable Privy — the localnet
 * e2e does exactly that so the funded dev burner is the one-click
 * connection; that stays available in prod too, just no longer as a default.
 */
const PRIVY_APP_ID_FALLBACK = "cmtlbhuh402u30cjv957bvump";

export const privyAppIdFrom = (
  env: Record<string, string | undefined>,
  isProd: boolean,
): string | undefined => {
  const raw = env.VITE_PRIVY_APP_ID?.trim();
  if (raw === "" || raw?.toLowerCase() === "off") return undefined;
  if (raw) return raw;
  if (isProd) {
    throw new Error(
      'VITE_PRIVY_APP_ID is required in a production build; set a real app id, or "off" to use standard wallets.',
    );
  }
  return PRIVY_APP_ID_FALLBACK;
};

export interface WalletEnvironment extends Record<string, string | undefined> {
  VITE_PRIVY_APP_ID?: string;
  VITE_PRIVY_CLIENT_ID?: string;
}

/** Privy boots only when an App ID is configured; otherwise standard wallets. */
export const walletModeFor = (
  env: WalletEnvironment,
  isProd: boolean,
): WalletMode => (privyAppIdFrom(env, isProd) ? "privy" : "standard");

// Built once: connectors register wallet-standard listeners, and a fresh set
// per render (or per StrictMode double-mount) can miss Phantom's injection.
const SOLANA_CONNECTORS = toSolanaWalletConnectors({ shouldAutoConnect: true });

/**
 * WebSocket endpoint for an HTTP RPC URL. The local validator serves
 * subscriptions one port up (8899 -> 8900); hosted RPCs use the same host.
 */
export const rpcSubscriptionsUrlFor = (rpcUrl: string): string => {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.port === "8899") url.port = "8900";
  return url.toString();
};

/**
 * Privy's transaction UI (the dry run before signing, and sign-and-send)
 * reads the chain RPC
 * from `config.solana.rpcs`; without an entry for the chain it signs on it
 * throws "No RPC configuration found for chain solana:devnet". Both come
 * from `VITE_CLUSTER` (see SIGNING_CHAIN in chain.ts), so the app's own RPC
 * is registered under whichever chain this bundle signs against.
 */
const solanaRpcsFor = (rpcUrl: string) => ({
  [SIGNING_CHAIN]: {
    rpc: createSolanaRpc(rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(
      rpcSubscriptionsUrlFor(rpcUrl),
    ),
    blockExplorerUrl: "https://explorer.solana.com",
  },
});

/** App root: wraps children in PrivyProvider only when Privy is configured. */
export function WalletLayer({
  env,
  children,
}: {
  env: WalletEnvironment;
  children: ReactNode;
}) {
  const appId = privyAppIdFrom(env, import.meta.env.PROD);
  const clientId = env.VITE_PRIVY_CLIENT_ID?.trim() || undefined;
  const rpcs = useMemo(() => solanaRpcsFor(RPC_URL), []);
  if (appId) {
    return (
      <PrivyProvider
        appId={appId}
        {...(clientId ? { clientId } : {})}
        config={{
          // Overrides the dashboard's login methods; no "wallet" button.
          loginMethods: ["google", "email"],
          appearance: {
            theme: "#0E1B2B",
            accentColor: "#B6FF3B",
            // Ticket 14: Privy defaults to ethereum-only, which connects
            // Phantom's EVM side instead of its Solana one.
            walletChainType: "solana-only",
          },
          externalWallets: {
            solana: { connectors: SOLANA_CONNECTORS },
          },
          embeddedWallets: {
            showWalletUIs: false,
            solana: {
              createOnLogin: "users-without-wallets",
            },
          },
          solana: { rpcs },
        }}
      >
        {children}
      </PrivyProvider>
    );
  }
  return <>{children}</>;
}

const WalletModeContext = createContext<WalletMode>("standard");
export const useWalletMode = (): WalletMode => useContext(WalletModeContext);

/** Publishes the active wallet mode; mount above <GameSignerProvider>. */
export function WalletModeProvider({
  mode,
  children,
}: {
  mode: WalletMode;
  children: ReactNode;
}) {
  return (
    <WalletModeContext.Provider value={mode}>
      {children}
    </WalletModeContext.Provider>
  );
}

const GameSignerContext = createContext<GameSigner | null>(null);

/**
 * The one hook the app uses. Only valid below <GameSignerProvider>.
 */
export function useGameSigner(): GameSigner {
  const signer = useContext(GameSignerContext);
  if (!signer) throw new Error("GameSignerProvider is not mounted");
  return signer;
}

/**
 * Mounts exactly one signer implementation: Privy's hooks require its
 * provider, so the mode decides which subtree renders — no conditional hook
 * calls anywhere.
 */
export function GameSignerProvider({ children }: { children: ReactNode }) {
  const mode = useWalletMode();
  return mode === "privy" ? (
    <PrivySignerSource mode={mode}>{children}</PrivySignerSource>
  ) : (
    <StandardSignerSource mode={mode}>{children}</StandardSignerSource>
  );
}

function PrivySignerSource({
  mode,
  children,
}: {
  mode: WalletMode;
  children: ReactNode;
}) {
  const signer = usePrivySigner();
  useWalletIdentity(signer);
  return (
    <GameSignerContext.Provider value={{ ...signer, mode }}>
      {children}
    </GameSignerContext.Provider>
  );
}

function StandardSignerSource({
  mode,
  children,
}: {
  mode: WalletMode;
  children: ReactNode;
}) {
  const signer = useStandardSigner();
  useWalletIdentity(signer);
  return (
    <GameSignerContext.Provider value={{ ...signer, mode }}>
      {children}
    </GameSignerContext.Provider>
  );
}

/**
 * PostHog identity (posthog-analytics ticket 02): identify on connect, reset
 * on disconnect. The ref holds the last identified pubkey, so only a real
 * transition fires; a first mount with no wallet and StrictMode's effect
 * re-run both see no change and stay silent.
 */
function useWalletIdentity({ mode, connected, publicKey }: GameSigner): void {
  const pubkey = connected ? publicKey?.toBase58() : undefined;
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (pubkey === previous.current) return;
    if (previous.current) {
      track("wallet_disconnected");
      resetIdentity();
    }
    if (pubkey) {
      identifyWallet(pubkey, { cluster: CLUSTER, mode });
      track("wallet_connected", { mode });
    }
    previous.current = pubkey;
  }, [pubkey, mode]);
}

function usePrivySigner(): GameSigner {
  const { login } = useLogin();
  const { logout } = useLogout();
  // `useWallets` is the wallet Privy actually connected for this session
  // (embedded or external). `useStandardWallets` lists every Solana wallet
  // Privy knows about, connected or not, so its first entry can be a wallet
  // that cannot sign for the address the app then uses as fee payer.
  const { wallets, ready } = useWallets();
  const { signTransaction: privySign } = useSignTransaction();
  const { signAndSendTransaction: privySend } = useSignAndSendTransaction();
  const { signMessage: privySignMessage } = useSignMessage();
  const wallet = wallets[0];
  // Privy's own wallet-standard implementation flags itself; Phantom and
  // friends connected through Privy do not, and keep paying their own fees.
  const embedded = Boolean(
    wallet &&
      (wallet.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet,
  );

  const sendTransaction = useCallback(
    async (transaction: Transaction) => {
      if (!wallet) throw new Error("no Privy Solana wallet connected");
      const bytes = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const { signature } = await privySend({
        transaction: bytes,
        wallet,
        chain: SIGNING_CHAIN,
        options: { sponsor: true },
      });
      return anchorUtils.bytes.bs58.encode(signature);
    },
    [wallet, privySend],
  );

  const signTransaction = useCallback(
    async <T extends Transaction | VersionedTransaction>(transaction: T) => {
      if (!wallet) throw new Error("no Privy Solana wallet connected");
      // Anchor builds the tx with its own copy of web3.js (pnpm keeps two,
      // split on a peer dep), so `instanceof Transaction` is false for a
      // legacy tx. Anchor's own check: only VersionedTransaction has `version`.
      const versioned = "version" in transaction;
      // A legacy Transaction verifies signatures on serialize() by default,
      // which throws "Missing signature" on the unsigned tx we hand to Privy.
      const bytes = versioned
        ? (transaction as VersionedTransaction).serialize()
        : (transaction as Transaction).serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          });
      const { signedTransaction } = await privySign({
        transaction: bytes,
        wallet,
        chain: SIGNING_CHAIN,
      });
      const signed = Uint8Array.from(signedTransaction);
      return (
        versioned
          ? VersionedTransaction.deserialize(signed)
          : Transaction.from(Buffer.from(signed))
      ) as T;
    },
    [wallet, privySign],
  );

  const signMessage = useCallback(
    async (message: Uint8Array) => {
      if (!wallet) throw new Error("no Privy Solana wallet connected");
      const { signature } = await privySignMessage({ message, wallet });
      return signature;
    },
    [wallet, privySignMessage],
  );

  return {
    mode: "privy",
    publicKey: wallet ? safePubkey(wallet.address) : undefined,
    ready,
    connected: ready && Boolean(wallet),
    connect: () => login(),
    // `logout()` only ends the Privy session. An external wallet Privy
    // auto-connected through wallet-standard stays in `useWallets`, so the
    // pill kept showing its address after the X. Drop the wallet too, and
    // don't let one failing (a 400 on an already-dead session) skip the other.
    disconnect: () => {
      void Promise.allSettled([wallet?.disconnect(), logout()]);
    },
    signTransaction,
    signMessage,
    ...(embedded ? { sendTransaction } : {}),
  };
}

function useStandardSigner(): GameSigner {
  const { publicKey, wallet, connected, connecting, select, signIn } = useWallet();
  const { setVisible } = useWalletModal();

  const adapter = wallet?.adapter as unknown as
    | {
        signTransaction?: <T extends Transaction | VersionedTransaction>(
          tx: T,
        ) => Promise<T>;
        signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
        disconnect?: () => Promise<void>;
      }
    | undefined;

  return {
    mode: "standard",
    publicKey: publicKey ?? undefined,
    // autoConnect selects the stored wallet in a mount effect, so the very
    // first render can still say "not connecting". Good enough for the dev
    // fallback; Privy is the production path.
    ready: !connecting,
    connected,
    connect: () => setVisible(true),
    disconnect: () => {
      void adapter?.disconnect?.();
      select(null as never);
    },
    signTransaction: adapter?.signTransaction?.bind(wallet!.adapter),
    signMessage: adapter?.signMessage?.bind(wallet!.adapter),
    signIn: signIn
      ? async (input) => {
          const out = await signIn(input);
          return {
            address: out.account.address,
            signedMessage: out.signedMessage,
            signature: out.signature,
          };
        }
      : undefined,
  };
}

const safePubkey = (address: string): PubkeyType | undefined => {
  try {
    return new PublicKey(address);
  } catch {
    return undefined;
  }
};

/** Convenience: `useConnection` re-export so App imports one wallet module. */
