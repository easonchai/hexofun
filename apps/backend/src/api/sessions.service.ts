// Session delegation storage (off-chain-tickets ticket 15). The pure checks
// live in session.ts; this holds the nonces, the Session rows, and
// `checkSession`, the one function ticket 16's bet route calls.
import { randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Session } from "@prisma/client";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import {
  NONCE_TTL_SECONDS,
  verifyDelegation,
  verifyRevoke,
  type DelegationCode,
  type RevokeCode,
} from "./session";

/** What ticket 16 answers a bet with when the key is unknown, expired or revoked. */
export type SessionInvalid = "SessionInvalid";

export type CreateResult =
  | { ok: true; session: Session }
  | { ok: false; code: DelegationCode };

export type RevokeResult =
  | { ok: true; session: Session }
  | { ok: false; code: RevokeCode | "SessionNotFound" };

@Injectable()
export class SessionsService {
  private readonly allowedOrigins: string[];
  private readonly chainId: string;
  private readonly programId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.allowedOrigins = config
      .get("CORS_ORIGIN", { infer: true })
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
    this.chainId = config.get("CLUSTER", { infer: true });
    this.programId = config.get("PROGRAM_ID", { infer: true });
  }

  /** A single-use 16-byte base58 nonce with a 10 minute life. Expired ones are
   *  swept on the way, so the table stays the size of the live window. */
  async issueNonce(now: Date = new Date()): Promise<{ nonce: string; expiresAt: Date }> {
    const nonce = bs58.encode(randomBytes(16));
    const expiresAt = new Date(now.getTime() + NONCE_TTL_SECONDS * 1000);
    await this.prisma.sessionNonce.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.prisma.sessionNonce.create({ data: { nonce, expiresAt } });
    return { nonce, expiresAt };
  }

  /** True once per live nonce: the delete is the claim. */
  private async consumeNonce(nonce: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.sessionNonce.deleteMany({
      where: { nonce, expiresAt: { gt: now } },
    });
    return count === 1;
  }

  async create(
    message: string,
    signature: Uint8Array,
    now: Date = new Date(),
  ): Promise<CreateResult> {
    const result = await verifyDelegation(
      { message, signature },
      {
        now,
        allowedOrigins: this.allowedOrigins,
        chainId: this.chainId,
        programId: this.programId,
        consumeNonce: (nonce) => this.consumeNonce(nonce, now),
      },
    );
    if (!result.ok) return result;
    const { delegation } = result;
    const session = await this.prisma.session.create({
      data: {
        poolAddress: this.chain.poolAddress().toBase58(),
        wallet: delegation.wallet,
        sessionPubkey: delegation.sessionPubkey,
        message,
        signature: bs58.encode(signature),
        issuedAt: delegation.issuedAt,
        expiresAt: delegation.expiresAt,
      },
    });
    return { ok: true, session };
  }

  /** Sets `revokedAt` once; a second revoke leaves the first time standing. */
  async revoke(
    id: string,
    input: { time: number; signature: Uint8Array },
    now: Date = new Date(),
  ): Promise<RevokeResult> {
    const session = await this.prisma.session.findUnique({ where: { id } });
    if (!session) return { ok: false, code: "SessionNotFound" };
    const verified = verifyRevoke(session, input, now);
    if (!verified.ok) return verified;
    if (session.revokedAt) return { ok: true, session };
    const revoked = await this.prisma.session.update({
      where: { id },
      data: { revokedAt: now },
    });
    return { ok: true, session: revoked };
  }

  /** The live Session for a session key: the row exists, has not expired and
   *  has not been revoked. Ticket 16's bet route calls this first and answers
   *  `SessionInvalid` on a miss. */
  async checkSession(
    sessionPubkey: string,
    now: Date = new Date(),
  ): Promise<{ ok: true; session: Session } | { ok: false; code: SessionInvalid }> {
    const session = await this.prisma.session.findUnique({ where: { sessionPubkey } });
    if (!session || session.revokedAt !== null || session.expiresAt <= now) {
      return { ok: false, code: "SessionInvalid" };
    }
    return { ok: true, session };
  }
}
