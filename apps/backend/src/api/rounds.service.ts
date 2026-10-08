// The off-chain game engine (off-chain-tickets tickets 16 and 17): accept a
// signed bet, open a Round on the first one, close it on the minute, then
// reveal its tile from a drand beacon and settle it as ledger rows, or void it
// when the beacon never comes. Every write runs in one transaction under the
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
import { lockLedger } from "../ledger/ledger-store";
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
        .then(() => this.revealDue())
        .catch((cause: unknown) => this.logger.error(`closing or revealing Rounds failed: ${String(cause)}`));
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
   * Reveals and settles closed Rounds in id order, each in its own transaction.
   * The relays are asked outside the transaction. A Round whose beacon is not
   * out yet ends the pass (later Rounds emit later); one whose beacon no relay
   * gave a valid signature for stays `closed` for the next pass, unless the
   * beacon is `VOID_AFTER_MS` overdue, then it is voided and refunded.
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
      for (const { id, closeAt } of closed) {
        const round = beaconRoundFor(closeAt);
        const emittedAt = beaconTime(round).getTime();
        if (now.getTime() < emittedAt) break;
        const beacon = await fetchVerifiedBeacon(this.relays, round, (relay, cause) =>
          this.logger.warn(`no usable beacon ${round} from ${relay} for Round ${id}: ${String(cause)}`),
        );
        const overdue = now.getTime() >= emittedAt + VOID_AFTER_MS;
        if (beacon === null && !overdue) continue;
        await this.prisma.$transaction(
          async (tx) => {
            await lockLedger(tx, poolAddress);
            await this.settleIn(tx, id, beacon);
          },
          { timeout: 30_000 },
        );
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

    // A reset booked after a wallet's stake row has already given the stake back (ADR 0020).
    const owners = placed.map((p) => p.owner);
    const resetOwners = new Set(
      (
        await tx.$queryRaw<{ owner: string }[]>`
          SELECT DISTINCT s."owner" FROM "TicketLedger" s
          WHERE s."poolAddress" = ${poolAddress} AND s."owner" = ANY(${owners}::text[]) AND s."reason" = 'stake' AND s."ref" = ${roundId.toString()}
            AND EXISTS (
              SELECT 1 FROM "TicketLedger" r
              WHERE r."poolAddress" = s."poolAddress" AND r."owner" = s."owner" AND r."reason" = 'reset' AND r."id" > s."id")`
      ).map((row) => row.owner),
    );
    const positions: SettlePosition[] = placed.map((p) => ({
      owner: p.owner,
      tiles: p.tiles,
      stakePerTile: p.stakePerTile,
      restored: resetOwners.has(p.owner),
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

    const cursor = await tx.cursor.findUnique({ where: { poolAddress }, select: { ledgerEpochId: true } });
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
   * accepted bet into an empty board opens the Round. A refusal writes nothing
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
