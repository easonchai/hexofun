import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Post,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import {
  DEFAULT_GAME_CONFIG,
  verifyGameConfigChange,
  type GameConfigRefusal,
} from "./game-config";

const HISTORY_LIMIT = 100;

const REFUSAL_COPY: Record<GameConfigRefusal, string> = {
  WalletNotListed: "That wallet may not change the Game config.",
  RequestStale: "That request is too old or too far ahead. Sign it again.",
  FieldOutOfRange: "A Game config field is missing or out of range.",
  BadSignature: "The signature does not match this pool, time and these fields.",
};

function parseBody(body: unknown): {
  wallet: PublicKey;
  time: number;
  signature: Uint8Array;
  fields: unknown;
} {
  const raw = body as
    | { wallet?: unknown; time?: unknown; signature?: unknown; fields?: unknown }
    | null
    | undefined;
  if (typeof raw?.wallet !== "string" || raw.wallet.length === 0) {
    throw new BadRequestException("Send a JSON body with a `wallet` address.");
  }
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(raw.wallet);
  } catch {
    throw new BadRequestException("`wallet` is not a valid Solana wallet address.");
  }
  if (typeof raw.time !== "number" || !Number.isSafeInteger(raw.time)) {
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
  return { wallet, time: raw.time, signature, fields: raw.fields };
}

/**
 * The Game config (off-chain-tickets ticket 14): an append-only, signed row
 * per pool, the newest in force. A listed team wallet signs the change the way
 * Fast pause is signed; `POST` answers 404 when `OPS_WALLETS` is empty.
 */
@Controller()
export class GameConfigController implements OnModuleInit {
  private readonly logger = new Logger(GameConfigController.name);
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.allowed = new Set(config.get("OPS_WALLETS", { infer: true }) ?? []);
  }

  /** A pool with no row gets the defaults once, so the engine always has a row in force. */
  async onModuleInit(): Promise<void> {
    const poolAddress = this.chain.poolAddress().toBase58();
    const seeded = await this.prisma.$transaction(async (tx) => {
      if ((await tx.gameConfig.count({ where: { poolAddress } })) > 0) return false;
      await tx.gameConfig.create({ data: { poolAddress, ...DEFAULT_GAME_CONFIG } });
      return true;
    });
    if (seeded) this.logger.log(`seeded the Game config for ${poolAddress}`);
  }

  @Get("game/config")
  async getConfig() {
    const history = await this.prisma.gameConfig.findMany({
      where: { poolAddress: this.chain.poolAddress().toBase58() },
      orderBy: { id: "desc" },
      take: HISTORY_LIMIT,
    });
    return { inForce: history[0] ?? null, history };
  }

  @Post("ops/game-config")
  async change(@Body() body: unknown) {
    if (this.allowed.size === 0) throw new NotFoundException();
    const { wallet, time, signature, fields } = parseBody(body);
    const pool = this.chain.poolAddress().toBase58();
    const verdict = verifyGameConfigChange({
      allowed: this.allowed,
      wallet,
      pool,
      time,
      fields,
      signature,
      nowSeconds: Date.now() / 1000,
    });
    if (!verdict.ok) {
      const error = { code: verdict.code, message: REFUSAL_COPY[verdict.code] };
      throw verdict.code === "FieldOutOfRange"
        ? new BadRequestException(error)
        : new ForbiddenException(error);
    }
    try {
      const row = await this.prisma.gameConfig.create({
        data: {
          poolAddress: pool,
          ...verdict.fields,
          signer: wallet.toBase58(),
          signature: bs58.encode(signature),
          message: verdict.message,
        },
      });
      this.logger.warn(`game config ${row.id} set by ${row.signer}`);
      return row;
    } catch (cause) {
      // The unique signature: this exact signed change is already stored.
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002") {
        throw new ConflictException({ code: "AlreadyApplied", message: "That signed change was already applied." });
      }
      throw cause;
    }
  }
}
