/** Program id, env, PDA derivation. The chain is authoritative. */
import { clusterFrom, gameGated, jackpotGated } from "./cluster.js";
import idl from "./idl/hex_vault.json";
import { BN, Program } from "@anchor-lang/core";
import type { Idl } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  type Transaction,
  type TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";

export type HexVaultProgram = Program<Idl>;

/** Builder returned by `program.methods.<name>(...)`. */
export interface TxBuilder {
  accounts(accounts: Record<string, unknown>): TxBuilder;
  preInstructions(instructions: unknown[]): TxBuilder;
  remainingAccounts(accounts: unknown[]): TxBuilder;
  /** Unsigned legacy transaction; fee payer and blockhash left unset. */
  transaction(): Promise<Transaction>;
  /** The raw instruction, for combining more than one into one transaction
   *  (ticket 11's one-step shutdown withdraw). No RPC round trip. */
  instruction(): Promise<TransactionInstruction>;
}

/** Decoded-account accessor for one account type. */
export interface AccountApi {
  fetch(address: PublicKey): Promise<unknown>;
  fetchMultiple(addresses: PublicKey[]): Promise<(unknown | null)[]>;
}

/**
 * Loosely-typed view of the Anchor client: we drive it by IDL name instead of
 * generated types, so the app needs no codegen step.
 */
export interface ProgramApi {
  readonly methods: Record<string, (...args: unknown[]) => TxBuilder>;
  readonly account: Record<string, AccountApi>;
}

const apiOf = (program: HexVaultProgram): ProgramApi =>
  program as unknown as ProgramApi;

/**
 * Instruction builder by IDL name; fails loudly on a stale IDL copy. The
 * Anchor client camelCases the IDL on construction, so `buy_tickets` is
 * reached as `buyTickets` and the `Player` account as `player`.
 */
export const method = (
  program: HexVaultProgram,
  name: string,
): ((...args: unknown[]) => TxBuilder) => {
  const build = apiOf(program).methods[name];
  if (!build)
    throw new Error(`IDL has no instruction "${name}" (re-run sync-idl)`);
  return build;
};

/** Decoded-account accessor by IDL name. */
export const accountOf = (
  program: HexVaultProgram,
  name: string,
): AccountApi => {
  const api = apiOf(program).account[name];
  if (!api) throw new Error(`IDL has no account "${name}" (re-run sync-idl)`);
  return api;
};

export interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
}

const DATA_PREFIXES = ["Program data: ", "Program log: "];

/**
 * One spelling for an event name. The Anchor client camelCases the IDL, so a
 * decoded log says `roundSettled` while the IDL (and possibly the API's
 * `/feed`) says `RoundSettled`. Compare through this.
 */
export const eventKey = (name: string): string =>
  name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Anchor's `emit!` writes the event as base64 behind `Program data:`, so the
 * name never appears in plain text — every log reader has to decode. One
 * helper serves both the activity feed and read.ts's settle trigger.
 */
export function decodeEventLogs(
  program: HexVaultProgram,
  logs: readonly string[],
): DecodedEvent[] {
  const coder = (
    program as unknown as {
      coder: { events: { decode(log: string): DecodedEvent | null } };
    }
  ).coder;
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    const prefix = DATA_PREFIXES.find((value) => line.startsWith(value));
    if (!prefix) continue;
    try {
      const event = coder.events.decode(line.slice(prefix.length));
      if (event) out.push(event);
    } catch {
      // Not one of ours, or a truncated log line. Skip it.
    }
  }
  return out;
}

/** Trims a static `import.meta.env.VITE_X` read; blank counts as unset. */
const trimmed = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/**
 * The cluster this bundle was built for; `vite.config.ts` rejects a bad one.
 * Read as one static `import.meta.env.VITE_X` access per variable (ticket
 * 07): Vite only inlines what a bundle statically references, so passing the
 * whole `import.meta.env` object through, as this used to, ships every
 * VITE_* value the build saw, used or not — including a keyed RPC URL.
 */
export const CLUSTER = clusterFrom({
  VITE_CLUSTER: import.meta.env.VITE_CLUSTER,
});

/** Ticket 01 (feature-gates): read once here, like `CLUSTER`, so no
 *  component touches `import.meta.env` for it. */
export const GAME_GATED = gameGated(import.meta.env.VITE_GATE_GAME);

/** Ticket 02 (feature-gates): the jackpot gate, same rule as `GAME_GATED`. */
export const JACKPOT_GATED = jackpotGated(import.meta.env.VITE_GATE_JACKPOT);

/**
 * Wallet-standard chain id. Privy signs against it and registers the app's
 * RPC under it; a local validator answers to the devnet genesis, so it rides
 * along with devnet.
 */
export const SIGNING_CHAIN =
  CLUSTER === "devnet" ? "solana:devnet" : "solana:mainnet";

/**
 * VITE_PROGRAM_ID wins so one bundle can point at a redeployed program.
 * `App.tsx` reads this same constant for the Anchor `Program`'s address
 * override, so PDAs (derived here) and instructions (sent through that
 * `Program`) can never point at two different program ids. A production
 * build has no IDL fallback: signing against the dev address baked into the
 * committed IDL would be a silent wrong-program bug, not a config default.
 */
export function programIdFrom(
  raw: string | undefined,
  idlAddress: string,
  isProd: boolean,
): PublicKey {
  if (raw) return new PublicKey(raw);
  if (isProd) {
    throw new Error(
      "VITE_PROGRAM_ID is required in a production build; refusing to fall back to the IDL's dev address.",
    );
  }
  return new PublicKey(idlAddress);
}

export const PROGRAM_ID = programIdFrom(
  trimmed(import.meta.env.VITE_PROGRAM_ID),
  idl.address,
  import.meta.env.PROD,
);

/** The single pool this build talks to; the demo runs pool 1. */
export const POOL_ID = BigInt(trimmed(import.meta.env.VITE_POOL_ID) ?? "1");

/** The cluster's public endpoint unless overridden; .env.example pins the local validator. */
export const RPC_URL =
  trimmed(import.meta.env.VITE_PUBLIC_RPC_URL) ?? clusterApiUrl(CLUSTER);

export const API_URL =
  trimmed(import.meta.env.VITE_API_URL) ?? "http://127.0.0.1:8080";

export const bn = (value: bigint | number | string): BN =>
  new BN(value.toString());

export const toBigint = (value: BN): bigint => BigInt(value.toString());

const pda = (seeds: (Uint8Array | Buffer)[]): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

const le8 = (value: bigint): Buffer => bn(value).toArrayLike(Buffer, "le", 8);

export const poolAddress = (poolId: bigint): PublicKey =>
  pda([Buffer.from("pool"), le8(poolId)]);

export const epochAddress = (pool: PublicKey, epochId: bigint): PublicKey =>
  pda([Buffer.from("epoch"), pool.toBuffer(), le8(epochId)]);

export const playerAddress = (pool: PublicKey, owner: PublicKey): PublicKey =>
  pda([Buffer.from("player"), pool.toBuffer(), owner.toBuffer()]);

export const principalVaultAddress = (pool: PublicKey): PublicKey =>
  pda([Buffer.from("principal"), pool.toBuffer()]);

/** `Pool::venue_kind` (programs/hex_vault/src/constants.rs `venue_kind`): which
 *  backing the four pinned venue keys point at. 2 is a Kamino Earn vault. */
export const VENUE_KIND = { klend: 0, stub: 1, kvault: 2 } as const;

/** The pool's open venue proposal; the account exists only while one is open,
 *  and `deploy_to_venue` refuses while it does. */
export const venueProposalAddress = (pool: PublicKey): PublicKey =>
  pda([Buffer.from("venue_proposal"), pool.toBuffer()]);

export const jackpotVaultAddress = (pool: PublicKey): PublicKey =>
  pda([Buffer.from("jackpot"), pool.toBuffer()]);

export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;

/** USDC is a classic SPL Token mint, so the ATA is the classic one. */
export const acceptedAta = (mint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
