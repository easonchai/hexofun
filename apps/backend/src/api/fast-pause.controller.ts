import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Logger,
  NotFoundException,
  Post,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { TransactionInstruction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { OperatorInstructions } from "../operator/instructions";
import {
  FAST_PAUSE_SWITCHES,
  fastPauseMessage,
  verifySignedMessage,
  type FastPauseSwitch,
} from "./invite-code";

/** How far a request's time may sit from the server's clock, either way. */
export const FAST_PAUSE_WINDOW_SECONDS = 120;

interface FastPauseBody {
  feature: FastPauseSwitch;
  wallet: PublicKey;
  time: number;
  signature: Uint8Array;
}

function parseBody(body: unknown): FastPauseBody {
  const raw = body as
    | { switch?: unknown; wallet?: unknown; time?: unknown; signature?: unknown }
    | null
    | undefined;
  const feature = FAST_PAUSE_SWITCHES.find((name) => name === raw?.switch);
  if (feature === undefined) {
    throw new BadRequestException(
      `\`switch\` must be one of ${FAST_PAUSE_SWITCHES.join(", ")}.`,
    );
  }
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
  return { feature, wallet, time: raw.time, signature };
}

/**
 * Fast pause (ops-console ticket 06): a listed team wallet signs a message and
 * the Operator key sets one pause switch to `true`. No path here can send
 * `false`; the builders it calls only take `true`. Throttled in api.module.ts.
 * Answers 404 when `OPS_WALLETS` is empty, as the invite admin route does
 * without its key.
 */
@Controller("ops")
export class FastPauseController {
  private readonly logger = new Logger(FastPauseController.name);
  private readonly allowed: ReadonlySet<string>;
  private readonly instructions: OperatorInstructions;

  constructor(
    private readonly chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    this.allowed = new Set(config.get("OPS_WALLETS", { infer: true }) ?? []);
    this.instructions = new OperatorInstructions(
      chain.program,
      chain.programId,
      chain.keypair.publicKey,
      false,
    );
  }

  @Post("fast-pause")
  async fastPause(@Body() body: unknown): Promise<{ signature: string }> {
    if (this.allowed.size === 0) throw new NotFoundException();
    const { feature, wallet, time, signature } = parseBody(body);

    const address = wallet.toBase58();
    if (!this.allowed.has(address)) {
      throw new ForbiddenException("That wallet may not use Fast pause.");
    }
    if (Math.abs(Date.now() / 1000 - time) > FAST_PAUSE_WINDOW_SECONDS) {
      throw new ForbiddenException("That request is too old or too far ahead. Sign it again.");
    }
    const pool = this.chain.poolAddress();
    if (!verifySignedMessage(wallet, fastPauseMessage(feature, pool.toBase58(), time), signature)) {
      throw new ForbiddenException("The signature does not match this switch, pool and time.");
    }

    let sent: string;
    try {
      sent = await this.chain.send([await this.build(feature, pool)]);
    } catch (cause) {
      // The cause can hold the RPC url and program logs; it stays in the log.
      this.logger.error(`fast pause ${feature} by ${address} failed`, cause);
      throw new BadGatewayException(
        "The pause did not land. Use the CLI to pause.",
        { cause },
      );
    }
    this.logger.warn(`fast pause: wallet ${address} set ${feature}, tx ${sent}`);
    return { signature: sent };
  }

  private build(feature: FastPauseSwitch, pool: PublicKey): Promise<TransactionInstruction> {
    switch (feature) {
      case "pool":
        return this.instructions.setPauseOn(pool);
      case "game":
      case "jackpot":
        return this.instructions.setFeaturePauseOn(pool, feature);
      case "deploy":
        return this.instructions.setDeployPauseOn(pool);
    }
  }
}
