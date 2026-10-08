/**
 * The bet (off-chain-tickets ticket 18, spec "Bet"). The browser-held session
 * key signs a fixed-order text and `POST /game/bets` checks it; no wallet
 * popup per bet. `betMessage` mirrors the backend's (apps/backend/src/api/
 * bet.ts) byte for byte, and both tests pin one fixture string. Everything
 * with a side effect comes in through `BetDeps`, so the resend rules are
 * tested without a browser.
 */
import { utils as anchorUtils } from "@anchor-lang/core";
import type { Keypair } from "@solana/web3.js";

const bs58 = anchorUtils.bytes.bs58;

export interface BetFields {
  cluster: string;
  program: string;
  pool: string;
  round: bigint;
  /** The session key, base58. */
  session: string;
  seq: number;
  /** Protocol tiles 0..35, ascending. */
  tiles: number[];
  /** Tickets per tile, atomic units. */
  stake: bigint;
}

/** Research 02's bet text, no trailing newline. */
export function betMessage(f: BetFields): string {
  return [
    "HexVault bet v1",
    `cluster: ${f.cluster}`,
    `program: ${f.program}`,
    `pool: ${f.pool}`,
    `round: ${f.round}`,
    `session: ${f.session}`,
    `seq: ${f.seq}`,
    `tiles: ${f.tiles.join(",")}`,
    `stake: ${f.stake}`,
  ].join("\n");
}

/** Ed25519 through WebCrypto, like the burner wallet's `signMessage`. */
export async function signWithKey(keypair: Keypair, message: Uint8Array): Promise<Uint8Array> {
  // PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410).
  const pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  pkcs8.set(keypair.secretKey.slice(0, 32), 16);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("Ed25519", key, new Uint8Array(message)));
}

/** The refusal names `POST /game/bets` sends as `code`. */
export const BET_REFUSALS = [
  "SessionInvalid",
  "BadSignature",
  "SeqMismatch",
  "RoundClosed",
  "RoundAlreadyOpen",
  "RoundOutsideEpoch",
  "GamePaused",
  "BadTiles",
  "InsufficientTickets",
  "PositionExists",
] as const;
export type BetRefusalCode = (typeof BET_REFUSALS)[number];

export type BetPostResult =
  | { ok: true; roundId: string; opened: boolean; closeAt: string }
  | { ok: false; code: string; message: string; nextSeq?: number };

export interface BetApi {
  postBet(message: string, signature: string): Promise<BetPostResult>;
}

/** The HTTP side of `BetApi`. Nothing throws: a failure comes back as plain copy. */
export function httpBetApi(
  baseUrl: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): BetApi {
  return {
    async postBet(message, signature) {
      try {
        const response = await fetchImpl(`${baseUrl}/game/bets`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ message, signature }),
        });
        const body = (await response.json().catch(() => null)) as {
          roundId?: unknown;
          opened?: unknown;
          closeAt?: unknown;
          code?: unknown;
          message?: unknown;
          nextSeq?: unknown;
        } | null;
        if (response.ok && typeof body?.roundId === "string") {
          return { ok: true, roundId: body.roundId, opened: body.opened === true, closeAt: String(body.closeAt) };
        }
        return {
          ok: false,
          code: typeof body?.code === "string" ? body.code : response.status === 429 ? "Throttled" : `http_${response.status}`,
          message: typeof body?.message === "string" ? body.message : `HTTP ${response.status}`,
          ...(typeof body?.nextSeq === "number" ? { nextSeq: body.nextSeq } : {}),
        };
      } catch {
        return { ok: false, code: "network", message: "Could not reach the server. Try again." };
      }
    },
  };
}

export interface BetDeps {
  api: BetApi;
  storage: Pick<Storage, "getItem" | "setItem">;
  cluster: string;
  programId: string;
  pool: string;
  session: { id: string; keypair: Keypair };
  /** Mints the signature; a test passes a fake. */
  sign?: (keypair: Keypair, message: Uint8Array) => Promise<Uint8Array>;
}

const seqKey = (sessionId: string): string => `hexvault.bet-seq.v1.${sessionId}`;

/** The next `seq` for this session: stored beside the key, 0 for a fresh one. */
export function loadSeq(storage: Pick<Storage, "getItem">, sessionId: string): number {
  try {
    const stored = Number(storage.getItem(seqKey(sessionId)));
    return Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  } catch {
    return 0;
  }
}

function saveSeq(storage: Pick<Storage, "setItem">, sessionId: string, seq: number): void {
  try {
    storage.setItem(seqKey(sessionId), String(seq));
  } catch {
    // Storage blocked: a later bet resyncs from the server's SeqMismatch.
  }
}

export interface BetInput {
  /** Protocol tiles 0..35 in any order. */
  tiles: number[];
  /** Tickets per tile, atomic units. */
  stake: bigint;
  /** The open Round's id, or `nextRoundId` to open one. */
  round: bigint;
}

export type BetOutcome =
  | { ok: true; roundId: bigint; opened: boolean; closeAt: string }
  | { ok: false; code: string; message: string };

/**
 * Signs and posts one bet. Two refusals are the client's to fix, each once:
 * `RoundAlreadyOpen` means it named the id after the open Round, so it resends
 * into the Round before that; `SeqMismatch` carries the server's count, which
 * it adopts. Every other refusal goes back to the caller as it came.
 */
export async function sendBet(deps: BetDeps, input: BetInput): Promise<BetOutcome> {
  const sign = deps.sign ?? signWithKey;
  const tiles = [...input.tiles].sort((a, b) => a - b);
  let round = input.round;
  let seq = loadSeq(deps.storage, deps.session.id);
  let resentRound = false;
  let resyncedSeq = false;
  for (;;) {
    const message = betMessage({
      cluster: deps.cluster,
      program: deps.programId,
      pool: deps.pool,
      round,
      session: deps.session.keypair.publicKey.toBase58(),
      seq,
      tiles,
      stake: input.stake,
    });
    const signature = await sign(deps.session.keypair, new TextEncoder().encode(message));
    const posted = await deps.api.postBet(message, bs58.encode(signature));
    if (posted.ok) {
      saveSeq(deps.storage, deps.session.id, seq + 1);
      return { ok: true, roundId: BigInt(posted.roundId), opened: posted.opened, closeAt: posted.closeAt };
    }
    if (posted.code === "RoundAlreadyOpen" && !resentRound && round > 1n) {
      resentRound = true;
      round -= 1n;
    } else if (posted.code === "SeqMismatch" && posted.nextSeq !== undefined && !resyncedSeq) {
      resyncedSeq = true;
      seq = posted.nextSeq;
      saveSeq(deps.storage, deps.session.id, seq);
    } else {
      return { ok: false, code: posted.code, message: posted.message };
    }
  }
}
