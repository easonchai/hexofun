// The public record of one Round (off-chain-tickets ticket 19, spec "Round
// record"): everything a stranger needs to check the Round with no access to
// the backend, in the order docs/game-verification.md checks it. The unrevealed
// `seedSecret` is never read here; `seed` is null until the engine reveals it.
import { BadRequestException, Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { BEACON_ROUND_GUARD, QUICKNET, VOID_AFTER_MS } from "./drand";
import { ISSUED_AT_SKEW_SECONDS } from "./session";

/** Bump when a field is renamed or removed; the verifier script refuses versions it does not know. */
export const ROUND_RECORD_VERSION = 1;

@Controller()
export class RoundRecordController {
  private readonly poolAddress: string;
  private readonly cluster: string;
  private readonly programId: string;

  constructor(
    private readonly prisma: PrismaService,
    chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.poolAddress = chain.poolAddress().toBase58();
    this.cluster = config.get("CLUSTER", { infer: true });
    this.programId = config.get("PROGRAM_ID", { infer: true });
  }

  @Get("rounds/:id/record")
  async getRecord(@Param("id") id: string) {
    if (!/^[1-9]\d{0,18}$/.test(id)) throw new BadRequestException("`id` must be a whole number of 1 or more.");
    const { poolAddress } = this;
    // One snapshot, so a settle landing mid-read cannot show rows from two states.
    const record = await this.prisma.$transaction(
      async (tx) => {
        const round = await tx.round.findUnique({ where: { poolAddress_id: { poolAddress, id: BigInt(id) } } });
        if (round === null) return null;
        const positions = await tx.position.findMany({
          where: { poolAddress, roundId: round.id },
          orderBy: { id: "asc" },
        });
        const owners = [...new Set(positions.map((p) => p.owner))];
        const sessions = await tx.session.findMany({
          where: {
            poolAddress,
            wallet: { in: owners },
            expiresAt: { gt: round.openAt },
            issuedAt: { lte: new Date(round.closeAt.getTime() + ISSUED_AT_SKEW_SECONDS * 1000) },
          },
          orderBy: [{ issuedAt: "asc" }, { id: "asc" }],
        });
        const [config, rows] = await Promise.all([
          tx.gameConfig.findUniqueOrThrow({ where: { id: round.configId } }),
          tx.ticketLedger.findMany({
            where: { poolAddress, ref: round.id.toString(), reason: { in: ["reward", "refund", "house_credit"] } },
            orderBy: { id: "asc" },
          }),
        ]);
        return { round, positions, sessions, config, rows };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (record === null) throw new NotFoundException(`Round ${id} does not exist.`);

    const { round, positions, sessions, config, rows } = record;
    return {
      version: ROUND_RECORD_VERSION,
      cluster: this.cluster,
      program: this.programId,
      pool: poolAddress,
      round: round.id,
      status: round.status,
      epochId: round.epochId,
      config,
      commitment: { seedCommitment: round.seedCommitment, openAt: round.openAt },
      delegations: sessions.map((s) => ({
        wallet: s.wallet,
        sessionPubkey: s.sessionPubkey,
        message: s.message,
        signature: s.signature,
        issuedAt: s.issuedAt,
        expiresAt: s.expiresAt,
      })),
      positions: positions.map((p) => ({
        owner: p.owner,
        message: p.message,
        signature: p.signature,
        receivedAt: p.receivedAt,
      })),
      close: { closeAt: round.closeAt, betListHash: round.betListHash },
      beacon: {
        chainHash: QUICKNET.hash,
        roundGuard: BEACON_ROUND_GUARD,
        voidAfterSeconds: VOID_AFTER_MS / 1000,
        drandRound: round.drandRound,
        drandSignature: round.drandSignature,
        seed: round.seed,
        ctr: round.ctr,
        tile: round.tile,
      },
      settle: rows.map((r) => ({ owner: r.owner, reason: r.reason, delta: r.delta })),
      // Only the date is kept (not the wallet's revoke signature), so this section is the operator's word.
      revocations: sessions
        .filter((s) => s.revokedAt !== null && s.revokedAt >= round.openAt && s.revokedAt <= round.closeAt)
        .map((s) => ({ sessionPubkey: s.sessionPubkey, wallet: s.wallet, revokedAt: s.revokedAt })),
    };
  }
}
