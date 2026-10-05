// The Sparring player: a backend-owned wallet that buys one Position in every
// Round so a lone human is never the whole pot (docs/plan/sparring-player).
// It is an ordinary Player, not the House and not the Operator, and signs its
// own placements with its own keypair.
//
// Same shape as the operator crank: `playSparring` is pure over a fabricated
// chain state, and the service below is plumbing.
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Interval } from "@nestjs/schedule";
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import {
  ROUND_STATUS,
  clockUnixTimestamp,
  decodePlayer,
  decodePool,
  decodeRound,
  type PoolState,
  type RoundState,
} from "./chain-state";
import { OperatorInstructions } from "./instructions";

/** One whole Ticket per tile, matching the web app's default input. */
export const STAKE_PER_TILE = 1_000_000n;
/** Program's board size (`constants::TILE_COUNT`), bits 0..35 of the mask. */
const TILES = 36n;
/** Every tile, so whichever one wins, a human on it has someone to split with. */
export const ALL_TILES = (1n << TILES) - 1n;
/** Stop this many seconds before `buy_position` starts refusing, so a slow
 *  confirmation does not land inside the close buffer. */
const MARGIN = 2n;
/**
 * The safety net (ticket 03): the Operator wakes this service in-process the
 * moment its own `create_round` confirms, so this interval only has to catch
 * a Round opened by anyone else (or a missed wake). On the order of a minute,
 * same as the Operator's own safety tick.
 */
const SAFETY_TICK_MS = 60_000;

export interface SparringContext {
  /** Chain clock, not wall time, as everywhere else in this module. */
  readonly now: bigint;
  readonly pool: PoolState;
  /** The Round at `pool.openRoundId`, null when none is open. */
  readonly openRound: RoundState | null;
  readonly owner: PublicKey;
  /** The Sparring Player's Tickets, in atomic units. */
  readonly entries: bigint;
  /** Does a Position for this owner already exist in `openRound`? */
  readonly hasPosition: boolean;
  readonly ix: OperatorInstructions;
  send(instructions: TransactionInstruction[]): Promise<string>;
}

/** Buys one Position, or does nothing. Returns whether it bought. */
export async function playSparring(ctx: SparringContext): Promise<boolean> {
  const { pool, openRound } = ctx;
  if (!openRound || openRound.status !== ROUND_STATUS.OPEN) return false;
  if (ctx.hasPosition) return false;
  if (ctx.now > openRound.endsAt - pool.closeBuffer - MARGIN) return false;
  if (ctx.entries < STAKE_PER_TILE * TILES) return false;

  await ctx.send(
    await ctx.ix.buyPosition(
      pool,
      openRound.roundId,
      ctx.owner,
      ALL_TILES,
      STAKE_PER_TILE,
    ),
  );
  return true;
}

/**
 * Lost races, not failures: the Round closed between the read and the send, or
 * this tick's Position landed twice (the second `init` reports the account as
 * already in use, a raw Solana message rather than an IDL error name).
 */
const EXPECTED_ERRORS: ReadonlySet<string> = new Set([
  "RoundClosed",
  "RoundNotOpen",
]);
const isLostRace = (message: string): boolean =>
  EXPECTED_ERRORS.has(message) || message.includes("already in use");

@Injectable()
export class SparringService {
  private readonly logger = new Logger(SparringService.name);
  private readonly instructions: OperatorInstructions;
  /** Null switches the whole service off (`SPARRING_ENABLED` unset, or no
   *  `SPARRING_KEYPAIR`). */
  private readonly keypair: Keypair | null;
  /** Single-flight: a pass that overruns the interval skips the next one. */
  private running = false;

  constructor(
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    // Off unless SPARRING_ENABLED=true (ADR 0019), keypair or not: a wallet
    // left in an env file must not start it on a pool that ships it off.
    const secret = config.get("SPARRING_KEYPAIR", { infer: true });
    const enabled = config.get("SPARRING_ENABLED", { infer: true });
    this.keypair = enabled && secret ? Keypair.fromSecretKey(bs58.decode(secret)) : null;
    if (enabled && !secret) {
      this.logger.warn("SPARRING_ENABLED is set but SPARRING_KEYPAIR is not; sparring player off");
    } else {
      this.logger.log(
        this.keypair
          ? `sparring player on: ${this.keypair.publicKey.toBase58()}`
          : "sparring player off",
      );
    }
    // `buy_position` is permissionless and touches no randomness, so neither
    // the authority nor the test-vrf flag reaches the instruction it builds.
    this.instructions = new OperatorInstructions(
      chain.program,
      chain.programId,
      chain.keypair.publicKey,
      false,
    );
  }

  /** The safety net; see `SAFETY_TICK_MS`. */
  @Interval(SAFETY_TICK_MS)
  async tick(): Promise<void> {
    const keypair = this.keypair;
    if (!keypair || this.running) return;
    this.running = true;
    try {
      await this.playOnce(keypair);
    } catch (cause) {
      const error =
        cause instanceof Error ? cause : new Error(String(cause), { cause });
      // Either way the Round is skipped; the next tick re-reads the chain.
      if (isLostRace(error.message)) {
        this.logger.debug(`skipped: ${error.message}`);
      } else {
        this.logger.error(`sparring play failed: ${error.message}`, error.stack);
      }
    } finally {
      this.running = false;
    }
  }

  /** Called by the Operator once its own `create_round` confirms, so this
   *  player buys in without waiting for the safety tick above. Fire-and-forget:
   *  a failure here is logged by `tick()`'s own error handling, not thrown
   *  back into the Operator's tick. */
  wake(): void {
    void this.tick();
  }

  /** Two account reads: pool + clock + Player, then Round + Position. */
  private async playOnce(keypair: Keypair): Promise<void> {
    const owner = keypair.publicKey;
    const poolKey = this.chain.poolAddress();
    const [poolInfo, clockInfo, playerInfo] =
      await this.chain.connection.getMultipleAccountsInfo([
        poolKey,
        SYSVAR_CLOCK_PUBKEY,
        this.chain.playerAddress(owner),
      ]);
    if (!poolInfo) {
      this.logger.debug("pool does not exist; run bootstrap first");
      return;
    }
    if (!playerInfo) {
      this.logger.debug("sparring player has not deposited; run sparring-setup");
      return;
    }
    const pool = decodePool(this.chain.program, poolKey, poolInfo.data);
    if (pool.openRoundId === 0n) return;

    const roundKey = this.chain.roundAddress(pool.openRoundId);
    const [roundInfo, positionInfo] =
      await this.chain.connection.getMultipleAccountsInfo([
        roundKey,
        this.chain.positionAddress(roundKey, owner),
      ]);

    const bought = await playSparring({
      now: clockUnixTimestamp(clockInfo?.data),
      pool,
      openRound: roundInfo
        ? decodeRound(this.chain.program, roundInfo.data)
        : null,
      owner,
      entries: decodePlayer(this.chain.program, playerInfo.data).entries,
      hasPosition: positionInfo !== null,
      ix: this.instructions,
      send: (instructions) => this.chain.send(instructions, keypair),
    });
    if (bought) this.logger.log(`bought a position in round ${pool.openRoundId}`);
  }
}
