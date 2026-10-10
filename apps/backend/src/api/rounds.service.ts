// The off-chain game engine (off-chain-tickets tickets 16, 17 and 29): accept a
// signed bet, keep one Round open whenever the game can take bets, close it on
// the minute, then reveal its tile from a drand beacon and settle it as ledger
// rows, or void it when the beacon never comes. Every write runs in one transaction under the
// pool's Postgres advisory lock, so two bets cannot both open a Round, take the
// same seq or spend the same Tickets, and a settle cannot interleave with the
// indexer's reset.
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
import type { ChainClient } from "drand-client";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { LEDGER_TRANSACTION, lockLedger } from "../ledger/ledger-store";
import { betListHash, checkBet, parseBetMessage, seedCommitment, TILE_COUNT, type BetRefusal } from "./bet";
import { beaconRoundFor, beaconTime, defaultRelays, fetchVerifiedBeacon, VOID_AFTER_MS, type VerifiedBeacon } from "./drand";
import { deriveTile, potOf, settleRows, voidRows, type SettlePosition, type SettleRow } from "./round-settle";
import { SessionsService } from "./sessions.service";

/** How often the engine looks for a Round past its `closeAt`. */
const CLOSE_SWEEP_MS = 1000;

export type PlaceBetResult =
  | { ok: true; roundId: bigint; positionId: bigint; opened: boolean; closeAt: Date; receivedAt: Date }
  /** `nextSeq` rides on a `SeqMismatch`, so a client that lost count can resync. */
  | { ok: false; code: BetRefusal; nextSeq?: number };

@Injectable()
export class RoundsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoundsService.name);
  private readonly poolAddress: string;
  private readonly cluster: string;
  private readonly programId: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private revealing = false;
  /** Closed Rounds whose last settle threw, with the error; the alerts name them. In memory: a restart
   *  forgets them until the next sweep fails again, which is a second away. */
  private readonly settleFailures = new Map<bigint, string>();
  /** The beacon relays, in the order they are tried; tests swap in stubs. */
  relays: ChainClient[] = defaultRelays();

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
      this.closeDue()
        .then(() => this.openDue())
        .then(() => this.revealDue())
        .catch((cause: unknown) => this.logger.error(`closing or revealing Rounds failed: ${String(cause)}`));
    }, CLOSE_SWEEP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Ids of closed Rounds the last sweep could not settle, oldest first. */
  settleFailed(): bigint[] {
    return [...this.settleFailures.keys()].sort((a, b) => (a < b ? -1 : 1));
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
    }, LEDGER_TRANSACTION);
  }

  /**
   * Opens the next Round when none is open and the game can take bets: not
   * paused or shut down, and the Round's close inside the epoch (ADR 0026).
   * Its `closeAt` is the next minute mark, so Rounds run back to back on the
   * grid. Idempotent: a Round already open, found under the lock, ends it.
   */
  async openDue(now: Date = new Date()): Promise<void> {
    const newest = await this.prisma.round.findFirst({
      where: { poolAddress: this.poolAddress },
      orderBy: { id: "desc" },
      select: { status: true },
    });
    if (newest?.status === "open") return;
    await this.prisma.$transaction(async (tx) => {
      await lockLedger(tx, this.poolAddress);
      const poolAddress = this.poolAddress;
      const last = await tx.round.findFirst({ where: { poolAddress }, orderBy: { id: "desc" } });
      if (last?.status === "open") return;
      const pool = await tx.pool.findUnique({ where: { address: poolAddress } });
      if (pool === null || pool.gamePaused || pool.paused || pool.shutdown || pool.currentEpochId === 0n) return;
      const config = await tx.gameConfig.findFirst({ where: { poolAddress }, orderBy: { id: "desc" } });
      if (config === null) return;
      const step = config.roundSeconds * 1000;
      const closeAt = new Date((Math.floor(now.getTime() / step) + 1) * step);
      if (closeAt.getTime() > Number(pool.currentEpochEndsAt) * 1000) return;
      await this.createRound(tx, {
        id: (last?.id ?? 0n) + 1n,
        epochId: pool.currentEpochId,
        configId: config.id,
        openAt: now,
        closeAt,
      });
    }, LEDGER_TRANSACTION);
  }

  /** Writes a fresh Round with its seed commitment. Caller holds the lock. */
  private createRound(
    tx: Prisma.TransactionClient,
    r: { id: bigint; epochId: bigint; configId: number; openAt: Date; closeAt: Date },
  ) {
    const seed = randomBytes(32);
    return tx.round.create({
      data: {
        poolAddress: this.poolAddress,
        id: r.id,
        epochId: r.epochId,
        openAt: r.openAt,
        closeAt: r.closeAt,
        seedCommitment: seedCommitment(seed),
        seedSecret: seed.toString("hex"),
        tileTotals: Array<string>(TILE_COUNT).fill("0"),
        configId: r.configId,
      },
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
   * Reveals and settles closed Rounds in id order, each in its own transaction.
   * The relays are asked outside the transaction. A Round whose beacon is not
   * out yet ends the pass (later Rounds emit later); one whose beacon no relay
   * gave a valid signature for stays `closed` for the next pass, unless the
   * beacon is `VOID_AFTER_MS` overdue, then it is voided and refunded. A Round
   * whose settle throws is recorded in `settleFailed()` and skipped; the rest still settle.
   */
  async revealDue(now: Date = new Date()): Promise<void> {
    if (this.revealing) return;
    this.revealing = true;
    try {
      const poolAddress = this.poolAddress;
      const closed = await this.prisma.round.findMany({
        where: { poolAddress, status: "closed" },
        orderBy: { id: "asc" },
        select: { id: true, closeAt: true },
      });
      // A Round settled or voided some other way is no longer failing.
      const stillClosed = new Set(closed.map((row) => row.id));
      for (const id of this.settleFailures.keys()) if (!stillClosed.has(id)) this.settleFailures.delete(id);
      for (const { id, closeAt } of closed) {
        const round = beaconRoundFor(closeAt);
        const emittedAt = beaconTime(round).getTime();
        if (now.getTime() < emittedAt) break;
        const beacon = await fetchVerifiedBeacon(this.relays, round, (relay, cause) =>
          this.logger.warn(`no usable beacon ${round} from ${relay} for Round ${id}: ${String(cause)}`),
        );
        const overdue = now.getTime() >= emittedAt + VOID_AFTER_MS;
        if (beacon === null && !overdue) continue;
        // One bad Round must not hold back the ones after it: skip it for this sweep, retry on the next.
        try {
          await this.prisma.$transaction(
            async (tx) => {
              await lockLedger(tx, poolAddress);
              await this.settleIn(tx, id, beacon);
            },
            LEDGER_TRANSACTION,
          );
          this.settleFailures.delete(id);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          // The sweep retries every second; log a failure when it is new or its cause changed.
          if (this.settleFailures.get(id) !== message) this.logger.error(`Round ${id} failed to settle: ${message}`);
          this.settleFailures.set(id, message);
        }
      }
    } finally {
      this.revealing = false;
    }
  }

  /** Reveals (beacon given) or voids (null) one closed Round and books its rows. Caller holds the lock. */
  private async settleIn(tx: Prisma.TransactionClient, roundId: bigint, beacon: VerifiedBeacon | null): Promise<void> {
    const poolAddress = this.poolAddress;
    const round = await tx.round.findUnique({ where: { poolAddress_id: { poolAddress, id: roundId } } });
    if (round === null || round.status !== "closed") return;
    const placed = await tx.position.findMany({ where: { poolAddress, roundId }, orderBy: { id: "asc" } });
    if (potOf(placed.map((p) => ({ owner: p.owner, tiles: p.tiles, stakePerTile: p.stakePerTile, restored: false }))) !== round.pot) {
      throw new Error(`Round ${roundId} pot ${round.pot} does not match its Positions`);
    }

    // The reset gives every open stake back (ADR 0020), whether or not it wrote a row for the wallet.
    // Every `stake` row of this Round is booked at `round.epochId`, so a ledger epoch past it means restored.
    const cursor = await tx.cursor.findUnique({ where: { poolAddress }, select: { ledgerEpochId: true } });
    const restored = cursor !== null && cursor.ledgerEpochId > round.epochId;
    const positions: SettlePosition[] = placed.map((p) => ({
      owner: p.owner,
      tiles: p.tiles,
      stakePerTile: p.stakePerTile,
      restored,
    }));

    let rows: SettleRow[];
    let reveal: Prisma.RoundUpdateInput;
    if (beacon === null) {
      rows = voidRows(positions);
      reveal = { status: "voided" };
    } else {
      const config = await tx.gameConfig.findUniqueOrThrow({ where: { id: round.configId } });
      const house = await tx.player.findFirst({ where: { poolAddress, isHouse: true }, select: { owner: true } });
      if (house === null) throw new Error(`pool ${poolAddress} has no House player, so Round ${roundId} cannot settle`);
      const seed = Buffer.from(round.seedSecret, "hex");
      const signature = Buffer.from(beacon.signature, "hex");
      const { tile, ctr } = deriveTile(seed, signature, roundId);
      const settled = settleRows(positions, tile, config.houseCutBps, house.owner);
      rows = settled.rows;
      reveal = {
        status: "settled",
        seed: round.seedSecret,
        drandRound: BigInt(beacon.round),
        drandSignature: beacon.signature,
        ctr,
        tile,
        houseCut: settled.houseCut,
      };
    }

    const epochId = cursor !== null && cursor.ledgerEpochId > 0n ? cursor.ledgerEpochId : round.epochId;
    for (const { owner, reason, delta } of rows) {
      if (delta === 0n) continue;
      await tx.ticketLedger.create({ data: { poolAddress, owner, epochId, delta, reason, ref: roundId.toString() } });
      await tx.ticketBalance.upsert({
        where: { poolAddress_owner: { poolAddress, owner } },
        create: { poolAddress, owner, tickets: delta, epochId },
        update: { tickets: { increment: delta } },
      });
    }
    await tx.round.update({ where: { poolAddress_id: { poolAddress, id: roundId } }, data: reveal });
  }

  /**
   * Runs the spec's checks and, on a pass, writes the Position and the `stake`
   * ledger row and bumps the session's `nextSeq` in one transaction. The first
   * accepted bet with no Round open opens one (the engine normally has). A refusal writes nothing
   * beyond closing a Round that was already past `closeAt`.
   */
  async placeBet(message: string, signature: Uint8Array, at?: Date): Promise<PlaceBetResult> {
    // A cheap refusal before the lock, so garbage never queues on it; checkBet repeats it under the lock.
    const key = parseBetMessage(message)?.session;
    if (key === undefined) return { ok: false, code: "BadSignature" };
    const live = await this.sessions.checkSession(key, at);
    if (!live.ok) return live;
    const poolAddress = this.poolAddress;

    return this.prisma.$transaction(async (tx): Promise<PlaceBetResult> => {
      await lockLedger(tx, this.poolAddress);
      // Read after the lock, so `receivedAt` follows the accepted order and a bet that queued past `closeAt` is late.
      const now = at ?? new Date();
      await this.closeDueIn(tx, now);
      const pool = await tx.pool.findUnique({ where: { address: poolAddress } });
      if (pool === null) throw new NotFoundException("The pool is not indexed yet. Try again in a few seconds.");

      // A revoke or expiry that landed while this bet waited on the lock still refuses it.
      const row = await tx.session.findUnique({ where: { id: live.session.id } });
      const session = row !== null && row.revokedAt === null && row.expiresAt > now ? row : null;
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
      if (!verdict.ok) {
        return verdict.code === "SeqMismatch" && session !== null ? { ...verdict, nextSeq: session.nextSeq } : verdict;
      }

      const { bet, wallet, mask, opens } = verdict;
      const stake = BigInt(bet.tiles.length) * bet.stake;
      let round = open;
      if (opens !== null) {
        round = await this.createRound(tx, {
          id: bet.round,
          epochId: pool.currentEpochId,
          configId: config.id,
          openAt: now,
          closeAt: opens.closeAt,
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
    }, LEDGER_TRANSACTION);
  }
}
