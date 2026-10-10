import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Logger,
  NotFoundException,
  Post,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { LEDGER_TRANSACTION, lockLedger } from "../ledger/ledger-store";
import { PrismaService } from "../prisma/prisma.service";
import { DEFAULT_MAX_ADMIN_GRANT } from "./game-config";
import { verifyGrant, type GrantRefusal } from "./grants";

const REFUSAL_COPY: Record<GrantRefusal, string> = {
  WalletNotListed: "That wallet may not grant Tickets.",
  RequestStale: "That request is too old or too far ahead. Sign it again.",
  AmountOutOfRange: "`amount` must be a whole number of Tickets, at least 1 and at most the Game config's maxAdminGrant.",
  ReasonInvalid: "`reason` must be 1 to 200 characters.",
  BadSignature: "The signature does not match this pool, wallet, amount, reason and time.",
};

function pubkey(field: string, raw: unknown): PublicKey {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new BadRequestException(`Send a JSON body with a \`${field}\` address.`);
  }
  try {
    return new PublicKey(raw);
  } catch {
    throw new BadRequestException(`\`${field}\` is not a valid Solana wallet address.`);
  }
}

function parseBody(body: unknown) {
  const raw = body as Record<string, unknown> | null | undefined;
  const wallet = pubkey("wallet", raw?.wallet);
  const signer = pubkey("signer", raw?.signer);
  if (typeof raw?.time !== "number" || !Number.isSafeInteger(raw.time)) {
    throw new BadRequestException("`time` must be a whole number of unix seconds.");
  }
  if (typeof raw.signature !== "string" || raw.signature.length === 0) {
    throw new BadRequestException("Send a JSON body with a base58 `signature`.");
  }
  let signature: Uint8Array;
  try {
    signature = bs58.decode(raw.signature);
  } catch {
    throw new BadRequestException("`signature` must be base58.");
  }
  if (signature.length !== 64) {
    throw new BadRequestException("`signature` must be a 64-byte ed25519 signature.");
  }
  return { wallet, signer, time: raw.time, signature, amount: raw.amount, reason: raw.reason };
}

/**
 * Manual grants (off-chain-tickets ticket 23): a listed team wallet signs one
 * grant and the backend books a `grant_admin` ledger row with the signer and
 * signature on it, then moves the balance. Capped per grant by the Game
 * config's `maxAdminGrant`; House included. Answers
 * 404 when `OPS_WALLETS` is empty, as Fast pause does.
 */
@Controller("ops")
export class GrantsController {
  private readonly logger = new Logger(GrantsController.name);
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.allowed = new Set(config.get("OPS_WALLETS", { infer: true }) ?? []);
  }

  @Post("grants")
  async grant(@Body() body: unknown) {
    if (this.allowed.size === 0) throw new NotFoundException();
    const { wallet, signer, time, signature, amount, reason } = parseBody(body);
    const poolAddress = this.chain.poolAddress().toBase58();
    const owner = wallet.toBase58();
    const inForce = await this.prisma.gameConfig.findFirst({
      where: { poolAddress },
      orderBy: { id: "desc" },
      select: { maxAdminGrant: true },
    });
    const verdict = verifyGrant({
      maxAmount: inForce?.maxAdminGrant ?? DEFAULT_MAX_ADMIN_GRANT,
      allowed: this.allowed,
      signer,
      pool: poolAddress,
      wallet: owner,
      amount,
      reason,
      time,
      signature,
      nowSeconds: Date.now() / 1000,
    });
    if (!verdict.ok) {
      const error = { code: verdict.code, message: REFUSAL_COPY[verdict.code] };
      throw verdict.code === "AmountOutOfRange" || verdict.code === "ReasonInvalid"
        ? new BadRequestException(error)
        : new ForbiddenException(error);
    }
    try {
      // One transaction: a replay fails on the unique signature and moves nothing.
      const row = await this.prisma.$transaction(async (tx) => {
        await lockLedger(tx, poolAddress);
        const cursor = await tx.cursor.findUnique({ where: { poolAddress }, select: { ledgerEpochId: true } });
        const epochId = cursor?.ledgerEpochId ?? 0n;
        const booked = await tx.ticketLedger.create({
          data: {
            poolAddress,
            owner,
            epochId,
            delta: verdict.amount,
            reason: "grant_admin",
            ref: verdict.reason,
            signer: signer.toBase58(),
            signature: bs58.encode(signature),
          },
        });
        await tx.ticketBalance.upsert({
          where: { poolAddress_owner: { poolAddress, owner } },
          create: { poolAddress, owner, tickets: verdict.amount, epochId },
          update: { tickets: { increment: verdict.amount } },
        });
        return booked;
      }, LEDGER_TRANSACTION);
      this.logger.warn(`grant ${row.id}: ${row.signer} gave ${verdict.amount} Tickets to ${owner}`);
      return row;
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        throw new ConflictException({ code: "AlreadyApplied", message: "That signed grant was already applied." });
      }
      throw cause;
    }
  }
}
