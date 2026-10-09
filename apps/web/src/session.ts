/**
 * Session delegation (off-chain-tickets ticket 15, spec "Session delegation").
 * A connected wallet signs once per 24 hours a SIWS-shaped text that names a
 * browser-held ed25519 key; the key then signs bets with no wallet popup.
 *
 * `delegationMessage` mirrors the backend exactly
 * (apps/backend/src/api/session.ts): the server rebuilds the text and refuses
 * a single differing byte. Everything with a side effect (storage, clock,
 * network, wallet) comes in through `SessionDeps`, so the prompt rules are
 * tested without a browser.
 */
import { utils as anchorUtils } from "@anchor-lang/core";
import { Keypair } from "@solana/web3.js";

const bs58 = anchorUtils.bytes.bs58;

/** The delegation runs this long from its `Issued At`. */
export const SESSION_SECONDS = 24 * 60 * 60;
/** A live session with less than this left is replaced as the drawer opens. */
export const REFRESH_BELOW_MS = 5 * 60 * 1000;

export const DELEGATION_STATEMENT =
  "Authorize a HexVault betting session. This key can place bets in the game and cannot withdraw.";

export interface DelegationFields {
  domain: string;
  wallet: string;
  uri: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  sessionPubkey: string;
  programId: string;
}

/** Research 02's delegation text, byte for byte. */
export function delegationMessage(f: DelegationFields): string {
  return [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.wallet,
    "",
    DELEGATION_STATEMENT,
    "",
    `URI: ${f.uri}`,
    "Version: 1",
    `Chain ID: ${f.chainId}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
    "Resources:",
    `- hexvault:session:${f.sessionPubkey}`,
    `- hexvault:program:${f.programId}`,
  ].join("\n");
}

/** The SIWS input a wallet's `signIn` builds `delegationMessage` from. */
export interface SignInInput {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  resources: string[];
}

export interface SignInOutput {
  address: string;
  signedMessage: Uint8Array;
  signature: Uint8Array;
}

/** What the wallet layer offers. `signIn` is preferred when present. */
export interface SessionSigner {
  wallet: string;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
  signIn: ((input: SignInInput) => Promise<SignInOutput>) | undefined;
}

/** True when the connected wallet can sign neither SIWS nor a message: the
 *  stock Ledger adapter. It sees the Ledger copy and cannot open the drawer. */
export const cannotSignMessages = (signer: {
  signMessage?: unknown;
  signIn?: unknown;
}): boolean => !signer.signMessage && !signer.signIn;

/** The spec's "Ledger users" line, word for word. */
export const LEDGER_COPY =
  "Ledger wallets can deposit and win the daily draw but cannot play the game. " +
  "Connect a software wallet to play.";

export type NonceResult =
  | { ok: true; nonce: string }
  | { ok: false; message: string };
export type PostResult =
  | { ok: true; id: string; expiresAt: string }
  | { ok: false; code: string; message: string };

export interface SessionApi {
  fetchNonce(): Promise<NonceResult>;
  postSession(message: string, signature: string): Promise<PostResult>;
}

export interface SessionDeps {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Milliseconds, as `Date.now`. */
  now: () => number;
  api: SessionApi;
  /** `window.location.origin`; must be one of the backend's `CORS_ORIGIN`. */
  origin: string;
  /** `VITE_CLUSTER`. */
  cluster: string;
  programId: string;
  signer: SessionSigner;
  /** Mints the session key; a test passes a fixed one. */
  generateKeypair?: () => Keypair;
}

/** What `localStorage` holds for one wallet. */
interface StoredSession {
  secretKey: number[];
  id: string;
  /** Milliseconds. */
  expiresAt: number;
}

export interface LiveSession {
  keypair: Keypair;
  id: string;
  expiresAt: number;
}

const storageKey = (wallet: string): string => `hexvault.session.v1.${wallet}`;

/** The wallet's stored session if it is readable and unexpired; null otherwise. */
export function loadSession(
  deps: Pick<SessionDeps, "storage" | "now">,
  wallet: string,
): LiveSession | null {
  try {
    const raw = deps.storage.getItem(storageKey(wallet));
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Partial<StoredSession>;
    if (
      !Array.isArray(stored.secretKey) ||
      typeof stored.id !== "string" ||
      typeof stored.expiresAt !== "number" ||
      stored.expiresAt <= deps.now()
    ) {
      return null;
    }
    return {
      keypair: Keypair.fromSecretKey(Uint8Array.from(stored.secretKey)),
      id: stored.id,
      expiresAt: stored.expiresAt,
    };
  } catch {
    return null;
  }
}

/** Forgets the wallet's key, so the next `ensureSession` asks the wallet again.
 *  Called after a `SessionInvalid` refusal. */
export function dropSession(deps: Pick<SessionDeps, "storage">, wallet: string): void {
  try {
    deps.storage.removeItem(storageKey(wallet));
  } catch {
    // Storage blocked: there is nothing stored to forget.
  }
}

export type EnsureResult =
  | { ok: true; session: LiveSession; prompted: boolean }
  | { ok: false; reason: "cannot_sign" | "rejected" | "network" | "refused"; message: string };

const isoSeconds = (ms: number): string =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The live session, delegating first when there is none or it has under five
 * minutes left. A fresh delegation mints a fresh key, so the server's
 * `sessionPubkey` stays unique per row; the old key is overwritten here.
 */
export async function ensureSession(deps: SessionDeps): Promise<EnsureResult> {
  const { signer } = deps;
  const live = loadSession(deps, signer.wallet);
  if (live && live.expiresAt - deps.now() >= REFRESH_BELOW_MS) {
    return { ok: true, session: live, prompted: false };
  }
  if (cannotSignMessages(signer)) {
    return { ok: false, reason: "cannot_sign", message: LEDGER_COPY };
  }

  const nonce = await deps.api.fetchNonce();
  if (!nonce.ok) return { ok: false, reason: "network", message: nonce.message };

  const keypair = (deps.generateKeypair ?? Keypair.generate)();
  const issuedMs = Math.floor(deps.now() / 1000) * 1000;
  const fields: DelegationFields = {
    domain: new URL(deps.origin).host,
    wallet: signer.wallet,
    uri: deps.origin,
    chainId: deps.cluster,
    nonce: nonce.nonce,
    issuedAt: isoSeconds(issuedMs),
    expirationTime: isoSeconds(issuedMs + SESSION_SECONDS * 1000),
    sessionPubkey: keypair.publicKey.toBase58(),
    programId: deps.programId,
  };

  let message: string;
  let signature: Uint8Array;
  try {
    if (signer.signIn) {
      const out = await signer.signIn({
        domain: fields.domain,
        address: fields.wallet,
        statement: DELEGATION_STATEMENT,
        uri: fields.uri,
        version: "1",
        chainId: fields.chainId,
        nonce: fields.nonce,
        issuedAt: fields.issuedAt,
        expirationTime: fields.expirationTime,
        resources: [
          `hexvault:session:${fields.sessionPubkey}`,
          `hexvault:program:${fields.programId}`,
        ],
      });
      if (out.address !== signer.wallet) {
        return {
          ok: false,
          reason: "refused",
          message: "The wallet signed in with a different account than the one connected.",
        };
      }
      message = new TextDecoder().decode(out.signedMessage);
      signature = out.signature;
    } else {
      message = delegationMessage(fields);
      // SAFETY: cannotSignMessages above returned false and signIn is unset.
      signature = await signer.signMessage!(new TextEncoder().encode(message));
    }
  } catch {
    return { ok: false, reason: "rejected", message: "The wallet did not sign the session." };
  }

  const posted = await deps.api.postSession(message, bs58.encode(signature));
  if (!posted.ok) return { ok: false, reason: "refused", message: posted.message };

  const expiresAt = Date.parse(posted.expiresAt);
  const stored: StoredSession = {
    secretKey: Array.from(keypair.secretKey),
    id: posted.id,
    expiresAt,
  };
  try {
    deps.storage.setItem(storageKey(signer.wallet), JSON.stringify(stored));
  } catch {
    // Storage blocked: the session works for this page load only.
  }
  return { ok: true, session: { keypair, id: posted.id, expiresAt }, prompted: true };
}

/** The HTTP side of `SessionApi`. Nothing throws: a failure comes back as a
 *  plain-copy message, like the rest of api.ts. */
export function httpSessionApi(
  baseUrl: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): SessionApi {
  const json = { "content-type": "application/json", accept: "application/json" };
  const failure = (body: { message?: unknown } | null, status: number): string =>
    typeof body?.message === "string" ? body.message : `HTTP ${status}`;
  return {
    async fetchNonce() {
      try {
        const response = await fetchImpl(`${baseUrl}/game/sessions/nonce`, {
          headers: { accept: "application/json" },
        });
        const body = (await response.json().catch(() => null)) as
          | { nonce?: unknown; message?: unknown }
          | null;
        if (!response.ok || typeof body?.nonce !== "string") {
          return { ok: false, message: failure(body, response.status) };
        }
        return { ok: true, nonce: body.nonce };
      } catch {
        return { ok: false, message: "Could not reach the server. Try again." };
      }
    },
    async postSession(message, signature) {
      try {
        const response = await fetchImpl(`${baseUrl}/game/sessions`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ message, signature }),
        });
        const body = (await response.json().catch(() => null)) as
          | { id?: unknown; expiresAt?: unknown; code?: unknown; message?: unknown }
          | null;
        if (!response.ok || typeof body?.id !== "string" || typeof body.expiresAt !== "string") {
          const code = typeof body?.code === "string" ? body.code : "";
          return { ok: false, code, message: failure(body, response.status) };
        }
        return { ok: true, id: body.id, expiresAt: body.expiresAt };
      } catch {
        return { ok: false, code: "", message: "Could not reach the server. Try again." };
      }
    },
  };
}
