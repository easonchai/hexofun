import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { isUniqueConstraintViolation } from "./access.controller";
import { referralTiersFromRow } from "./game-config";
import { applyReferralMessage, normalizeInviteCode, verifyApplyReferralSignature } from "./invite-code";
import { bindReferral, ensureReferralCode } from "./referral-code";
import { buildReferralsResponse, type ReferralInput } from "./referral-summary";

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

const parseWallet = (raw: string): string => {
  try {
    return new PublicKey(raw).toBase58();
  } catch {
    throw new BadRequestException("That is not a valid Solana wallet address.");
  }
};

/** `?limit=` (spec.md "Referrals API response"): undefined for anything not
 *  a positive integer, so `buildReferralsResponse`'s own default (50) picks
 *  up rather than this route inventing a second default to keep in sync. */
const MAX_REFERRALS_PAGE_SIZE = 200;
function parseReferralsLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_REFERRALS_PAGE_SIZE) : undefined;
}

interface ApplyReferralBody {
  wallet: PublicKey;
  code: string;
  signature: Uint8Array;
}

function parseApplyReferralBody(body: unknown): ApplyReferralBody {
  const raw = body as
    | { wallet?: unknown; code?: unknown; signature?: unknown }
    | null
    | undefined;
  if (typeof raw?.wallet !== "string" || raw.wallet.length === 0) {
    throw new BadRequestException("Send a JSON body with a `wallet` address.");
  }
  // parseWallet above already validates and round-trips through toBase58();
  // re-wrapping it in a PublicKey here cannot throw.
  const wallet = new PublicKey(parseWallet(raw.wallet));
  if (typeof raw.code !== "string" || raw.code.trim().length === 0) {
    throw new BadRequestException("Send a JSON body with a referral `code`.");
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
  return { wallet, code: normalizeInviteCode(raw.code), signature };
}

/**
 * The referrals screen (docs/plan/hexo-referrals ticket 11): this wallet's
 * own Referral code (ADR 0014), its referrals with qualification state, the
 * current band and today's bonus `{amount,
 * uncapped}` (referral-page ticket 04). The response shape lives in
 * referral-summary.ts's `buildReferralsResponse` so it is unit tested
 * without a database; this controller only fetches the rows it needs.
 *
 * Not throttled, like the rest of ApiController's read routes: api.module.ts
 * only throttles the faucet, access and `POST /referrals/apply` below, which
 * spend resources or are worth rate-limiting against script abuse. This is a
 * plain wallet-keyed read, the same shape as GET /players/:owner.
 */
@Controller("referrals")
export class ReferralsController {
  /** The Active pool's address. Today's bonus is read off its Pool row and
   *  its grants only: epoch ids restart per pool (ADR 0016). */
  private readonly poolAddress: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<HexVaultEnv, true>,
    chain: ChainService,
  ) {
    this.poolAddress = chain.poolAddress().toBase58();
  }

  @Get(":wallet")
  async getReferrals(
    @Param("wallet") walletRaw: string,
    @Query("cursor") cursorRaw?: string,
    @Query("limit") limitRaw?: string,
  ) {
    const wallet = parseWallet(walletRaw);
    const qualifySeconds = this.config.get("REFERRAL_QUALIFY_SECONDS", { infer: true });

    const [referralCode, referralRows, pool, gameConfig] = await Promise.all([
      this.referralCodeFor(wallet),
      this.prisma.referral.findMany({
        where: { referrer: wallet },
        select: { referee: true, aboveSince: true, boundAt: true },
      }),
      this.prisma.pool.findUnique({ where: { address: this.poolAddress } }),
      // The row in force is the newest.
      this.prisma.gameConfig.findFirst({
        where: { poolAddress: this.poolAddress },
        orderBy: { id: "desc" },
        select: { referralTiers: true },
      }),
    ]);
    if (gameConfig === null) throw new Error(`pool ${this.poolAddress} has no Game config row, so the referral tiers are unknown`);
    const tiers = referralTiersFromRow(gameConfig.referralTiers, `pool ${this.poolAddress}`);

    const [grantToday, shares] = await Promise.all([
      this.bonusGrant(pool?.currentEpochId, wallet),
      this.referralShares(pool?.currentEpochId, wallet),
    ]);
    const referrals: ReferralInput[] = referralRows.map((row) => ({
      referee: row.referee,
      aboveSince: row.aboveSince,
      boundAt: row.boundAt,
      bonusToday: shares.get(row.referee) ?? 0n,
    }));

    return buildReferralsResponse(
      tiers,
      referralCode,
      referrals,
      nowSeconds(),
      qualifySeconds,
      { amount: grantToday?.amount ?? 0n, uncapped: grantToday?.uncapped ?? 0n },
      cursorRaw ?? null,
      parseReferralsLimit(limitRaw),
    );
  }

  /**
   * The wallet's Referral code, minting one for a wallet past the beta gate
   * that has not deposited yet so it can refer before it deposits (its own
   * bonus stays capped by its own Principal, which the Referral's Bonus card
   * already shows). A depositor's code comes from the indexer. Gated on an
   * InviteRedemption so this unthrottled GET can't mint rows for arbitrary
   * addresses.
   */
  private async referralCodeFor(wallet: string): Promise<string | null> {
    const owned = await this.prisma.referralCode.findUnique({ where: { owner: wallet } });
    if (owned !== null) return owned.code;
    const redeemed = await this.prisma.inviteRedemption.findUnique({ where: { wallet } });
    if (redeemed === null) return null;
    return ensureReferralCode(this.prisma, wallet);
  }

  /**
   * `POST /referrals/apply` (ADR 0014, ticket 02): covers a wallet already
   * past the beta gate that opens a `?ref=CODE` link, deposited or not.
   * One ed25519 signature over
   * `applyReferralMessage(wallet, code)` (invite-code.ts), distinct from the
   * redeem message so one can't be replayed as the other. Throttled in
   * api.module.ts alongside access, same abuse shape as redeem.
   *
   * Binding only writes a Referral when the wallet has no Referral yet, the
   * code exists, and its owner is not the wallet itself. Having deposited
   * is no bar: the 7-day qualification and the per-referral bonus cap are
   * the guard. Any of those failing answers 200 with `applied:
   * false` and a reason, never an error, so the web can ignore it quietly.
   * Only a bad signature is a 4xx.
   */
  @Post("apply")
  @HttpCode(HttpStatus.OK)
  async applyReferral(@Body() body: unknown) {
    const { wallet, code, signature } = parseApplyReferralBody(body);
    if (!verifyApplyReferralSignature(wallet, code, signature)) {
      throw new BadRequestException(
        `That signature does not match "${applyReferralMessage(wallet.toBase58(), code)}".`,
      );
    }
    const address = wallet.toBase58();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existingReferral = await tx.referral.findUnique({ where: { referee: address } });
        if (existingReferral !== null) {
          return { applied: false, reason: "This wallet already has a Referrer." };
        }
        const referralCode = await tx.referralCode.findUnique({ where: { code } });
        if (referralCode === null) {
          return { applied: false, reason: "That referral code does not exist." };
        }
        if (referralCode.owner === address) {
          return { applied: false, reason: "You cannot apply your own referral code." };
        }
        await bindReferral(tx, this.poolAddress, address, referralCode.owner, code);
        return { applied: true, reason: "referral applied" };
      });
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) {
        return { applied: false, reason: "This wallet already has a Referrer." };
      }
      throw cause;
    }
  }

  /** undefined `epochId` (no pool indexed yet) short-circuits without a
   *  query. */
  private bonusGrant(epochId: bigint | undefined, referrer: string) {
    if (epochId === undefined) return Promise.resolve(null);
    return this.prisma.referralGrant.findUnique({
      where: {
        poolAddress_epochId_referrer: { poolAddress: this.poolAddress, epochId, referrer },
      },
      select: { amount: true, uncapped: true },
    });
  }

  /** Each referee's own share of this referrer's today's grant
   *  (referral-page ticket 05), keyed by referee; a referral missing from
   *  the map (not part of the basis, or no grant yet) reads as 0 in
   *  `buildReferralsResponse`. */
  private async referralShares(
    epochId: bigint | undefined,
    referrer: string,
  ): Promise<Map<string, bigint>> {
    if (epochId === undefined) return new Map();
    const rows = await this.prisma.referralGrantShare.findMany({
      where: { poolAddress: this.poolAddress, epochId, referrer },
      select: { referee: true, amount: true },
    });
    return new Map(rows.map((row) => [row.referee, row.amount]));
  }
}
