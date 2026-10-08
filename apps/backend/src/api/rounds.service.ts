// The off-chain game engine's first half (off-chain-tickets ticket 16): accept
// a signed bet, open a Round on the first one, close it on the minute. Reveal
// and settle are ticket 17; a closed Round waits there. Every write runs in one
// transaction under a single Postgres advisory lock, so two bets cannot both
// open a Round, take the same seq or spend the same Tickets.
import { randomBytes } from "node:crypto";

import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma } from "@prisma/client";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { lockLedger } from "../ledger/ledger-store";
import { betListHash, checkBet, parseBetMessage, seedCommitment, TILE_COUNT, type BetRefusal } from "./bet";
import { SessionsService } from "./sessions.service";

/** How often the engine looks for a Round past its `closeAt`. */
const CLOSE_SWEEP_MS = 1000;

export type PlaceBetResult =
  | { ok: true; roundId: bigint; positionId: bigint; opened: boolean; closeAt: Date; receivedAt: Date }
  | { ok: false; code: BetRefusal };

@Injectable()
export class RoundsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoundsService.name);
  private readonly poolAddress: string;
  private readonly cluster: string;
  private readonly programId: string;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.poolAddress = chain.poolAddress().toBase58();
    this.cluster = config.get("CLUSTER", { infer: true });
    this.programId = config.get("PROGRAM_ID", { infer: true });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.closeDue().catch((cause: unknown) => this.logger.error(`closing due Rounds failed: ${String(cause)}`));
    }, CLOSE_SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Closes the pool's open Round when `closeAt` has passed. Idempotent. */
  async closeDue(now: Date = new Date()): Promise<void> {
    const due = await this.prisma.round.findFirst({
      where: { poolAddress: this.poolAddress, status: "open", closeAt: { lte: now } },
      select: { id: true },
    });
    if (due === null) return;
    await this.prisma.$transaction(async (tx) => {
      await lockLedger(tx, this.poolAddress);
      await this.closeDueIn(tx, now);
    });
  }

  /** Writes `betListHash` and sets `closed` on a Round past its `closeAt`. Caller holds the lock. */
  private async closeDueIn(tx: Prisma.TransactionClient, now: Date): Promise<void> {
    const poolAddress = this.poolAddress;
    const round = await tx.round.findFirst({ where: { poolAddress, status: "open", closeAt: { lte: now } } });
    if (round === null) return;
    const positions = await tx.position.findMany({
      where: { poolAddress, roundId: round.id },
      orderBy: { id: "asc" },
      select: { signature: true },
    });
    await tx.round.update({
      where: { poolAddress_id: { poolAddress, id: round.id } },
      data: { status: "closed", betListHash: betListHash(positions.map((p) => bs58.decode(p.signature))) },
    });
  }

  /**
   * Runs the spec's checks and, on a pass, writes the Position and the `stake`
   * ledger row and bumps the session's `nextSeq` in one transaction. The first
   * accepted bet into an empty board opens the Round. A refusal writes nothing
   * beyond closing a Round that was already past `closeAt`.
   */
  async placeBet(message: string, signature: Uint8Array, now: Date = new Date()): Promise<PlaceBetResult> {
    // A cheap refusal before the lock; checkBet repeats it on the row it reads under the lock.
    const key = parseBetMessage(message)?.session;
    const live = key === undefined ? null : await this.sessions.checkSession(key, now);
    const poolAddress = this.poolAddress;

    return this.prisma.$transaction(async (tx): Promise<PlaceBetResult> => {
      await lockLedger(tx, this.poolAddress);
      await this.closeDueIn(tx, now);
      const pool = await tx.pool.findUnique({ where: { address: poolAddress } });
      if (pool === null) throw new NotFoundException("The pool is not indexed yet. Try again in a few seconds.");

      const session = live?.ok ? await tx.session.findUnique({ where: { id: live.session.id } }) : null;
      const last = await tx.round.findFirst({ where: { poolAddress }, orderBy: { id: "desc" } });
      const open = last?.status === "open" ? last : null;
      const config =
        open === null
          ? await tx.gameConfig.findFirst({ where: { poolAddress }, orderBy: { id: "desc" } })
          : await tx.gameConfig.findUnique({ where: { id: open.configId } });
      if (config === null) throw new Error(`no Game config row for pool ${poolAddress}`);
      const balance = session === null ? null : await tx.ticketBalance.findUnique({ where: { poolAddress_owner: { poolAddress, owner: session.wallet } } });
      const hasPosition =
        open !== null && session !== null
          ? (await tx.position.count({ where: { poolAddress, roundId: open.id, owner: session.wallet } })) > 0
          : false;

      const verdict = checkBet(
        { message, signature },
        {
          now,
          cluster: this.cluster,
          program: this.programId,
          pool: poolAddress,
          session: session === null ? null : { wallet: session.wallet, nextSeq: session.nextSeq },
          openRound: open === null ? null : { id: open.id, closeAt: open.closeAt },
          nextRoundId: (last?.id ?? 0n) + 1n,
          epochEndsAt: pool.currentEpochId > 0n ? pool.currentEpochEndsAt : null,
          roundSeconds: config.roundSeconds,
          maxTilesPerBet: config.maxTilesPerBet,
          paused: pool.gamePaused || pool.paused || pool.shutdown,
          tickets: balance?.tickets ?? 0n,
          hasPosition,
        },
      );
      if (!verdict.ok) return verdict;

      const { bet, wallet, mask, opens } = verdict;
      const stake = BigInt(bet.tiles.length) * bet.stake;
      let round = open;
      if (opens !== null) {
        const seed = randomBytes(32);
        round = await tx.round.create({
          data: {
            poolAddress,
            id: bet.round,
            epochId: pool.currentEpochId,
            openAt: now,
            closeAt: opens.closeAt,
            seedCommitment: seedCommitment(seed),
            seedSecret: seed.toString("hex"),
            tileTotals: Array<string>(TILE_COUNT).fill("0"),
            configId: config.id,
          },
        });
      }
      if (round === null) throw new Error("unreachable: a passed bet has a Round");

      const tileTotals = (round.tileTotals as string[]).map((total, tile) =>
        mask & (1n << BigInt(tile)) ? (BigInt(total) + bet.stake).toString() : total,
      );
      await tx.round.update({
        where: { poolAddress_id: { poolAddress, id: round.id } },
        data: { pot: { increment: stake }, tileTotals },
      });
      const position = await tx.position.create({
        data: {
          poolAddress,
          roundId: round.id,
          owner: wallet,
          sessionId: session!.id,
          seq: bet.seq,
          tiles: mask,
          stakePerTile: bet.stake,
          message,
          signature: bs58.encode(signature),
          receivedAt: now,
        },
      });
      await tx.ticketLedger.create({
        data: { poolAddress, owner: wallet, epochId: round.epochId, delta: -stake, reason: "stake", ref: round.id.toString() },
      });
      await tx.ticketBalance.update({
        where: { poolAddress_owner: { poolAddress, owner: wallet } },
        data: { tickets: { decrement: stake } },
      });
      await tx.session.update({ where: { id: session!.id }, data: { nextSeq: { increment: 1 } } });
      return { ok: true, roundId: round.id, positionId: position.id, opened: opens !== null, closeAt: round.closeAt, receivedAt: now };
    });
  }
}
