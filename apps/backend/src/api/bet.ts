// Bet acceptance, pure and DB-free (off-chain-tickets ticket 16, spec "Bet",
// research 02). The session key signs a fixed-order text; `checkBet` runs the
// spec's checks in its order over facts the service has already read. The web
// builds the same text in ticket 18; both tests pin one fixture string.
import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import { verifySignedMessage } from "./invite-code";

/** Tiles on the board, indexed 0 to 35. */
export const TILE_COUNT = 36;

/** The refusal names, in the order the checks run. */
export type BetRefusal =
  | "SessionInvalid"
  | "BadSignature"
  | "SeqMismatch"
  | "RoundClosed"
  | "RoundAlreadyOpen"
  | "RoundOutsideEpoch"
  | "GamePaused"
  | "BadTiles"
  | "InsufficientTickets"
  | "PositionExists";

export interface BetFields {
  cluster: string;
  program: string;
  pool: string;
  round: bigint;
  /** The session key, base58. */
  session: string;
  seq: number;
  /** In the order the message lists them; `checkBet` requires ascending. */
  tiles: number[];
  /** Tickets per tile. */
  stake: bigint;
}

/** Research 02's bet text, byte for byte, no trailing newline. */
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

const LABELS = ["cluster", "program", "pool", "round", "session", "seq", "tiles", "stake"] as const;
const WHOLE = /^(0|[1-9]\d{0,18})$/;

function canonicalKey(text: string): boolean {
  try {
    return new PublicKey(text).toBase58() === text;
  } catch {
    return false;
  }
}

/**
 * The fields of a bet text, or null for anything that is not byte for byte
 * what `betMessage` writes: wrong labels, leading zeros, spaces, a second
 * copy of a line. Numbers are capped at 19 digits, inside a signed 64-bit.
 */
export function parseBetMessage(message: string): BetFields | null {
  const lines = message.split("\n");
  if (lines.length !== LABELS.length + 1 || lines[0] !== "HexVault bet v1") return null;
  const value: Record<string, string> = {};
  for (const [i, label] of LABELS.entries()) {
    const line = lines[i + 1]!;
    if (!line.startsWith(`${label}: `)) return null;
    value[label] = line.slice(label.length + 2);
  }
  const { cluster, program, pool, round, session, seq, tiles, stake } = value as Record<(typeof LABELS)[number], string>;
  if (!WHOLE.test(round) || !WHOLE.test(seq) || !WHOLE.test(stake) || !canonicalKey(session)) return null;
  if (tiles !== "" && !/^\d{1,2}(,\d{1,2})*$/.test(tiles)) return null;
  const fields: BetFields = {
    cluster,
    program,
    pool,
    round: BigInt(round),
    session,
    seq: Number(seq),
    tiles: tiles === "" ? [] : tiles.split(",").map(Number),
    stake: BigInt(stake),
  };
  // Rebuilding catches what the patterns let through, such as "07".
  return Number.isSafeInteger(fields.seq) && betMessage(fields) === message ? fields : null;
}

/** The bit mask stored on a Position: bit n set for tile n. */
export const tileMask = (tiles: readonly number[]): bigint => tiles.reduce((mask, tile) => mask | (1n << BigInt(tile)), 0n);

/**
 * `closeAt` for a Round opened at `openAt`: the first multiple of
 * `roundSeconds` (unix time) at or past `openAt + roundSeconds`, so betting
 * stays open at least a full `roundSeconds`.
 */
export function closeAtFor(openAt: Date, roundSeconds: number): Date {
  const step = roundSeconds * 1000;
  return new Date(Math.ceil((openAt.getTime() + step) / step) * step);
}

/** Hex sha256 over the accepted bets' raw 64-byte signatures, concatenated in accepted order. */
export function betListHash(signatures: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const signature of signatures) hash.update(signature);
  return hash.digest("hex");
}

/** Hex sha256 of the 32-byte seed, published when a Round opens. */
export const seedCommitment = (seed: Uint8Array): string => createHash("sha256").update(seed).digest("hex");

/** What the service has read, all under the engine's lock. */
export interface BetFacts {
  now: Date;
  cluster: string;
  program: string;
  pool: string;
  /** The Session row for the message's key, or null when there is none or it is not live. */
  session: { wallet: string; nextSeq: number } | null;
  /** The pool's newest Round, when it is open. */
  openRound: { id: bigint; closeAt: Date } | null;
  /** One past the pool's newest Round id; the id a new Round gets. */
  nextRoundId: bigint;
  /** The pool's current epoch end, unix seconds; null before the first epoch. */
  epochEndsAt: bigint | null;
  /** `roundSeconds` and `maxTilesPerBet` of the Game config the Round binds. */
  roundSeconds: number;
  maxTilesPerBet: number;
  /** `game_paused`, `paused` or `shutdown` on the Pool mirror. */
  paused: boolean;
  /** The wallet's available Tickets. */
  tickets: bigint;
  /** The wallet already has a Position in the open Round. */
  hasPosition: boolean;
}

export type BetVerdict =
  | { ok: true; bet: BetFields; wallet: string; mask: bigint; opens: { closeAt: Date } | null }
  | { ok: false; code: BetRefusal };

/**
 * The spec's checks, in its order. A text that does not parse names no session,
 * so it is `BadSignature`; a parsed text for another cluster, program or pool
 * is `BadSignature` too, as the key never signed it for this game.
 */
export function checkBet(input: { message: string; signature: Uint8Array }, f: BetFacts): BetVerdict {
  const refuse = (code: BetRefusal): BetVerdict => ({ ok: false, code });
  const bet = parseBetMessage(input.message);
  if (bet === null) return refuse("BadSignature");
  if (f.session === null) return refuse("SessionInvalid");
  const signed =
    bet.cluster === f.cluster &&
    bet.program === f.program &&
    bet.pool === f.pool &&
    verifySignedMessage(new PublicKey(bet.session), input.message, input.signature);
  if (!signed) return refuse("BadSignature");
  if (bet.seq !== f.session.nextSeq) return refuse("SeqMismatch");

  let opens: { closeAt: Date } | null = null;
  const open = f.openRound;
  if (open !== null && bet.round === open.id) {
    if (f.now.getTime() > open.closeAt.getTime()) return refuse("RoundClosed");
  } else if (bet.round !== f.nextRoundId) {
    return refuse("RoundClosed");
  } else if (open !== null) {
    return refuse("RoundAlreadyOpen");
  } else {
    const closeAt = closeAtFor(f.now, f.roundSeconds);
    if (f.epochEndsAt === null || closeAt.getTime() > Number(f.epochEndsAt) * 1000) return refuse("RoundOutsideEpoch");
    opens = { closeAt };
  }

  if (f.paused) return refuse("GamePaused");
  const ascending = bet.tiles.every((tile, i) => tile < TILE_COUNT && (i === 0 || tile > bet.tiles[i - 1]!));
  if (bet.tiles.length < 1 || bet.tiles.length > f.maxTilesPerBet || !ascending || bet.stake < 1n) {
    return refuse("BadTiles");
  }
  if (BigInt(bet.tiles.length) * bet.stake > f.tickets) return refuse("InsufficientTickets");
  if (f.hasPosition) return refuse("PositionExists");
  return { ok: true, bet, wallet: f.session.wallet, mask: tileMask(bet.tiles), opens };
}
