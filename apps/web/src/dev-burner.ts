/**
 * Dev-only in-memory burner wallet for automated browser testing of the
 * localnet app. NOT a custodial path for users: it is opt-in via
 * VITE_BURNER_WALLET=1, refuses any RPC endpoint that is not a local
 * validator, and its keypair lives only in page memory for the session.
 */
import {
  BaseWalletAdapter,
  WalletReadyState,
} from "@solana/wallet-adapter-base";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * Deterministic dev seed so an external test harness can pre-fund the burner
 * before the browser connects. Not used outside the VITE_BURNER_WALLET=1
 * local-validator path.
 */
export const burnerKeypair = (): Keypair => {
  const seed = new TextEncoder()
    .encode("hexvault-localnet-burner-v1")
    .slice(0, 32);
  const padded = new Uint8Array(32);
  padded.set(seed);
  padded.fill(7, seed.length);
  return Keypair.fromSeed(padded);
};

export class BurnerWalletAdapter extends BaseWalletAdapter {
  name = "Localnet Burner (dev)" as never;
  url = "https://solana.com/docs";
  supportedTransactionVersions = { legacy: true, 0: true } as never;
  icon =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMwMDIyZmYiLz48L3N2Zz4=";

  private keypair: Keypair | null = null;
  private _connecting = false;

  get connecting(): boolean {
    return this._connecting;
  }

  get connected(): boolean {
    return this.keypair !== null;
  }

  get readyState(): WalletReadyState {
    return WalletReadyState.Installed;
  }

  get publicKey(): PublicKey | null {
    return this.keypair?.publicKey ?? null;
  }

  /** Fund with `solana airdrop` externally before connecting. */
  async connect(): Promise<void> {
    this._connecting = true;
    try {
      this.keypair ??= burnerKeypair();
      this.emit("connect", this.keypair.publicKey);
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this.keypair = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
  ): Promise<T> {
    if (!this.keypair) throw new Error("burner wallet not connected");
    if (transaction instanceof Transaction) {
      transaction.partialSign(this.keypair);
      return transaction;
    }
    transaction.sign([this.keypair]);
    return transaction;
  }

  async sendTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T,
    connection: Connection,
  ): Promise<string> {
    const signed = await this.signTransaction(transaction);
    const raw = signed.serialize();
    return connection.sendRawTransaction(raw);
  }

  /** Ed25519 via WebCrypto: the invite gate and referrals sign messages. */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.keypair) throw new Error("burner wallet not connected");
    // PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410).
    const pkcs8 = new Uint8Array(48);
    pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
    pkcs8.set(this.keypair.secretKey.slice(0, 32), 16);
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("Ed25519", key, new Uint8Array(message)));
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[],
  ): Promise<T[]> {
    for (const transaction of transactions)
      await this.signTransaction(transaction);
    return transactions;
  }
}

/** True when the RPC endpoint is a local validator, not devnet or mainnet. */
export const isLocalRpc = (url: string | undefined): boolean => {
  try {
    const { hostname } = new URL(url ?? "");
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    // No VITE_PUBLIC_RPC_URL set: chain.ts defaults to the local validator.
    return url === undefined || url.trim() === "";
  }
};

/**
 * Gate: a dev build (`isDevBuild`, Vite's `import.meta.env.DEV`), the explicit env flag, AND a local RPC endpoint.
 * There is no cluster variable any more, so the endpoint is what says "this
 * is localnet". `isDevBuild` is false in every production build, so a missing RPC URL
 * (which `isLocalRpc` reads as local) cannot switch the burner on there.
 */
export const burnerEnabled = (
  environment: Record<string, string | undefined>,
  isDevBuild: boolean,
): boolean =>
  isDevBuild &&
  environment.VITE_BURNER_WALLET?.trim() === "1" &&
  isLocalRpc(environment.VITE_PUBLIC_RPC_URL);
