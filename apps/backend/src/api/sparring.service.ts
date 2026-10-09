// The Sparring player (off-chain-tickets ticket 20, ADR 0019): a backend-owned
// wallet that bets all 36 tiles in every open Round a human holds a Position
// in (ADR 0026), so a lone human is never
// the whole pot. It deposits once on chain (`sparring-setup`) to hold Tickets,
// delegates to a session key it generates, and bets through the same
// `RoundsService.placeBet` a human's POST /game/bets reaches, so its bets
// verify in the record like anyone's. It names only the open Round's id, never
// `nextRoundId`, so it never opens a Round.
import { createPrivateKey, sign as signEd25519 } from "node:crypto";

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { betMessage, TILE_COUNT } from "./bet";
import { RoundsService } from "./rounds.service";
import { delegationMessage, SESSION_MAX_SECONDS } from "./session";
import { SessionsService } from "./sessions.service";

/** One whole Ticket per tile (Tickets carry 6 decimals, as the USDC they mirror). */
export const STAKE_PER_TILE = 1_000_000n;
/** Every tile, so whichever one wins, a human on it has someone to split with. */
const ALL_TILES = Array.from({ length: TILE_COUNT }, (_, tile) => tile);
/** Looks for an open Round this often; the engine closes Rounds on a 1 s sweep. */
const POLL_MS = 1000;
/** A fresh delegation is signed when the live one has less than this left. */
export const RENEW_BEFORE_SECONDS = 60 * 60;
/** After a failed delegation, wait this long before the next try. */
const SESSION_RETRY_MS = 60_000;

function signRaw(keypair: Keypair, message: string): Uint8Array {
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(keypair.secretKey.subarray(0, 32)).toString("base64url"),
      x: Buffer.from(keypair.publicKey.toBytes()).toString("base64url"),
    },
    format: "jwk",
  });
  return new Uint8Array(signEd25519(null, Buffer.from(message, "utf8"), key));
}

interface LiveSession {
  key: Keypair;
  expiresAt: Date;
  /** The next bet's seq; the Session row starts at 0 and counts accepted bets. */
  seq: number;
}

@Injectable()
export class SparringService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SparringService.name);
  /** Null switches the whole service off (`SPARRING_ENABLED` unset, or no `SPARRING_KEYPAIR`). */
  private readonly wallet: Keypair | null;
  private readonly origin: string;
  private readonly cluster: string;
  private readonly programId: string;
  private readonly poolAddress: string;
  private session: LiveSession | null = null;
  private sessionRetryAt = 0;
  /** The newest Round already bet in or refused; neither is retried. */
  private doneRound: bigint | null = null;
  /** Single-flight: a pass that overruns the interval skips the next one. */
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly rounds: RoundsService,
    chain: ChainService,
    config: ConfigService<HexVaultEnv, true>,
  ) {
    // Off unless SPARRING_ENABLED=true (ADR 0019), keypair or not: a wallet
    // left in an env file must not start it on a pool that ships it off.
    const secret = config.get("SPARRING_KEYPAIR", { infer: true });
    const enabled = config.get("SPARRING_ENABLED", { infer: true });
    this.wallet = enabled && secret ? Keypair.fromSecretKey(bs58.decode(secret)) : null;
    if (enabled && !secret) {
      this.logger.warn("SPARRING_ENABLED is set but SPARRING_KEYPAIR is not; sparring player off");
    }
    // The delegation names an origin the backend accepts; the first is as good as any.
    this.origin = config.get("CORS_ORIGIN", { infer: true }).split(",")[0]?.trim() ?? "";
    this.cluster = config.get("CLUSTER", { infer: true });
    this.programId = config.get("PROGRAM_ID", { infer: true });
    this.poolAddress = chain.poolAddress().toBase58();
  }

  onModuleInit(): void {
    if (!this.wallet) return;
    this.logger.log(`sparring player on: ${this.wallet.publicKey.toBase58()}`);
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass: keep the delegation fresh, then bet into an open Round it has no Position in. */
  async tick(now: Date = new Date()): Promise<void> {
    const wallet = this.wallet;
    if (!wallet || this.running) return;
    this.running = true;
    try {
      const session = await this.ensureSession(wallet, now);
      if (session) await this.betIfOpen(wallet, session, now);
    } catch (cause) {
      this.logger.error(`sparring pass failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      this.running = false;
    }
  }

  /** The live delegation, signing a new one when none exists or it ends within `RENEW_BEFORE_SECONDS`. */
  private async ensureSession(wallet: Keypair, now: Date): Promise<LiveSession | null> {
    const current = this.session;
    if (current && current.expiresAt.getTime() - now.getTime() > RENEW_BEFORE_SECONDS * 1000) return current;
    if (now.getTime() < this.sessionRetryAt) return current && current.expiresAt > now ? current : null;

    const key = Keypair.generate();
    const issuedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const expiresAt = new Date(issuedAt.getTime() + SESSION_MAX_SECONDS * 1000);
    const { nonce } = await this.sessions.issueNonce(now);
    const message = delegationMessage({
      domain: new URL(this.origin).host,
      wallet: wallet.publicKey.toBase58(),
      uri: this.origin,
      chainId: this.cluster,
      nonce,
      issuedAt: issuedAt.toISOString().replace(".000Z", "Z"),
      expirationTime: expiresAt.toISOString().replace(".000Z", "Z"),
      sessionPubkey: key.publicKey.toBase58(),
      programId: this.programId,
    });
    const result = await this.sessions.create(message, signRaw(wallet, message), this.origin, now);
    if (!result.ok) {
      this.sessionRetryAt = now.getTime() + SESSION_RETRY_MS;
      this.logger.error(`sparring delegation refused: ${result.code}`);
      return current && current.expiresAt > now ? current : null;
    }
    this.session = { key, expiresAt: result.session.expiresAt, seq: 0 };
    return this.session;
  }

  private async betIfOpen(wallet: Keypair, session: LiveSession, now: Date): Promise<void> {
    const poolAddress = this.poolAddress;
    const open = await this.prisma.round.findFirst({
      where: { poolAddress, status: "open" },
      orderBy: { id: "desc" },
      select: { id: true, closeAt: true },
    });
    if (!open || open.closeAt <= now || open.id === this.doneRound) return;
    const owner = wallet.publicKey.toBase58();
    if ((await this.prisma.position.count({ where: { poolAddress, roundId: open.id, owner } })) > 0) {
      this.doneRound = open.id;
      return;
    }
    // Wait for a human: alone in an empty Round it would only pay the House cut on its own losing tiles (ADR 0026).
    if ((await this.prisma.position.count({ where: { poolAddress, roundId: open.id, owner: { not: owner } } })) === 0) return;

    const message = betMessage({
      cluster: this.cluster,
      program: this.programId,
      pool: poolAddress,
      round: open.id,
      session: session.key.publicKey.toBase58(),
      seq: session.seq,
      tiles: ALL_TILES,
      stake: STAKE_PER_TILE,
    });
    // Bet once per Round: a refusal (InsufficientTickets once its Tickets run out) is not retried.
    this.doneRound = open.id;
    // No placement time: the engine reads its own clock after taking the lock, as the HTTP route does.
    const result = await this.rounds.placeBet(message, signRaw(session.key, message));
    if (result.ok) {
      session.seq += 1;
      this.logger.log(`bet in round ${open.id}`);
    } else {
      // A bet that committed but threw on the way back leaves `seq` one behind; the refusal carries the fix.
      if (result.code === "SeqMismatch" && result.nextSeq !== undefined) session.seq = result.nextSeq;
      this.logger.warn(`bet in round ${open.id} refused: ${result.code}`);
    }
  }
}
