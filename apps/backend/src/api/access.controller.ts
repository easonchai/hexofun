import { createHash, timingSafeEqual } from "node:crypto";

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { ChainService } from "../chain/chain.service";
import type { HexVaultEnv } from "../config/env";

import { PrismaService } from "../prisma/prisma.service";
import { bindReferral } from "./referral-code";
import {
  accessMessage,
  generateInviteCode,
  INVITE_CODE_MAX_USES,
  inviteGrantCount,
  normalizeInviteCode,
  verifyAccessSignature,
} from "./invite-code";

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/** Unix seconds (how the DB stores every timestamp) to ISO 8601 for JSON. */
const toIso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

const parseWallet = (raw: string): PublicKey => {
  try {
    return new PublicKey(raw);
  } catch {
    throw new BadRequestException("That is not a valid Solana wallet address.");
  }
};

interface RedeemBody {
  wallet: PublicKey;
  code: string;
  signature: Uint8Array;
  /** Optional Referral code riding along on the redeem signature (ADR 0014,
   *  ticket 02); null when the client sent none. */
  referralCode: string | null;
}

function parseRedeemBody(body: unknown): RedeemBody {
  const raw = body as
    | { wallet?: unknown; code?: unknown; signature?: unknown; referralCode?: unknown }
    | null
    | undefined;
  if (typeof raw?.wallet !== "string" || raw.wallet.length === 0) {
    throw new BadRequestException("Send a JSON body with a `wallet` address.");
  }
  const wallet = parseWallet(raw.wallet);
  if (typeof raw.code !== "string" || raw.code.trim().length === 0) {
    throw new BadRequestException("Send a JSON body with an invite `code`.");
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
  let referralCode: string | null = null;
  if (raw.referralCode !== undefined && raw.referralCode !== null) {
    if (typeof raw.referralCode !== "string" || raw.referralCode.trim().length === 0) {
      throw new BadRequestException("`referralCode` must be a non-empty string when present.");
    }
    referralCode = normalizeInviteCode(raw.referralCode);
  }
  return { wallet, code: normalizeInviteCode(raw.code), signature, referralCode };
}

/** Same limits as `admin create-invite`, plus a ceiling on `count` so one
 *  request cannot fill the table. */
const MAX_INVITES_PER_REQUEST = 100;

interface CreateInvitesBody {
  maxUses: number;
  owner: string | null;
  count: number;
}

function parseCreateInvitesBody(body: unknown): CreateInvitesBody {
  const raw = body as { maxUses?: unknown; owner?: unknown; count?: unknown } | null | undefined;
  // Invite codes are single use from now on (ticket 07): `maxUses` defaults
  // to INVITE_CODE_MAX_USES rather than being required.
  const maxUses = raw?.maxUses ?? INVITE_CODE_MAX_USES;
  if (typeof maxUses !== "number" || !Number.isSafeInteger(maxUses) || maxUses < 1) {
    throw new BadRequestException("`maxUses` must be a positive whole number when present.");
  }
  const count = raw?.count ?? 1;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_INVITES_PER_REQUEST
  ) {
    throw new BadRequestException(`\`count\` must be a whole number from 1 to ${MAX_INVITES_PER_REQUEST}.`);
  }
  let owner: string | null = null;
  if (raw?.owner !== undefined && raw.owner !== null) {
    if (typeof raw.owner !== "string") {
      throw new BadRequestException("`owner` must be a wallet address.");
    }
    owner = parseWallet(raw.owner).toBase58();
  }
  return { maxUses, owner, count };
}

/** Hashing first gives both sides the same length, which `timingSafeEqual`
 *  needs, without leaking the key's length through an early return. Also
 *  checks webhooks.controller.ts's signature header. */
export const sameKey =(given: string, expected: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(given).digest(),
    createHash("sha256").update(expected).digest(),
  );

/** Exported for referrals.controller.ts's apply endpoint, which needs the
 *  same race-to-unique-constraint handling as redeem below. */
export const isUniqueConstraintViolation = (cause: unknown): boolean =>
  cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === "P2002";

/** Postgres advisory-lock key (ticket 07): an arbitrary but fixed number
 *  serializing the "read circulation, grant quota codes" section of redeem
 *  across concurrent requests, so two transactions can't both act on a
 *  stale circulation count and push it over INVITE_CIRCULATION_CAP. Scoped
 *  to the transaction (`pg_advisory_xact_lock`), so Postgres releases it on
 *  commit or rollback without any unlock call. */
const INVITE_QUOTA_LOCK_KEY = 472_819_003;

/**
 * The private-beta gate (docs/plan/hexo-referrals ticket 06). The program
 * itself is not gated; this is UI-only. Throttled in api.module.ts like
 * FaucetController, since redeem is the one endpoint here a script could
 * hammer trying codes.
 */
@Controller("access")
export class AccessController {
  private readonly inviteAdminKey: string | undefined;
  private readonly circulationCap: number;
  private readonly redeemGrantCount: number;

  /** The Active pool's address, for seeding a new Referral's qualification
   *  state from the redeemer's Player (`bindReferral`). */
  private readonly poolAddress: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<HexVaultEnv, true>,
    chain: ChainService,
  ) {
    this.poolAddress = chain.poolAddress().toBase58();
    this.inviteAdminKey = config.get("INVITE_ADMIN_KEY", { infer: true });
    this.circulationCap = config.get("INVITE_CIRCULATION_CAP", { infer: true });
    this.redeemGrantCount = config.get("INVITE_REDEEM_GRANT_COUNT", { infer: true });
  }

  /** 404 with `INVITE_ADMIN_KEY` unset, as if the admin routes did not
   *  exist; 401 on a missing or wrong `x-admin-key`. */
  private requireAdminKey(key: string | undefined): void {
    if (this.inviteAdminKey === undefined) {
      throw new NotFoundException();
    }
    if (typeof key !== "string" || !sameKey(key, this.inviteAdminKey)) {
      throw new UnauthorizedException("Missing or wrong `x-admin-key`.");
    }
  }

  /** Every Invite code with its redemptions, admin-keyed like `POST
   *  /access/invites`. Declared before `GET :wallet` so "invites" is not
   *  parsed as a wallet. No relation between the two tables (schema.prisma),
   *  so the join is done here. */
  @Get("invites")
  async listInvites(@Headers("x-admin-key") key: string | undefined) {
    this.requireAdminKey(key);
    const [codes, redemptions] = await Promise.all([
      this.prisma.inviteCode.findMany({ orderBy: { createdAt: "desc" } }),
      this.prisma.inviteRedemption.findMany(),
    ]);
    const byCode = new Map<string, { wallet: string; redeemedAt: string }[]>();
    for (const r of redemptions) {
      byCode.set(r.code, [...(byCode.get(r.code) ?? []), { wallet: r.wallet, redeemedAt: toIso(r.redeemedAt) }]);
    }
    return {
      invites: codes.map((c) => ({
        code: c.code,
        owner: c.ownerWallet,
        maxUses: c.maxUses,
        uses: c.uses,
        createdAt: toIso(c.createdAt),
        redeemed: c.uses >= c.maxUses,
        redemptions: byCode.get(c.code) ?? [],
      })),
    };
  }

  @Get(":wallet")
  async getAccess(@Param("wallet") walletRaw: string) {
    const wallet = parseWallet(walletRaw).toBase58();
    const [redemption, player] = await Promise.all([
      this.prisma.inviteRedemption.findUnique({ where: { wallet } }),
      // Cross-pool on purpose: a depositor from a retired pool stays let in
      // after a Pool cutover (ADR 0016).
      this.prisma.player.findFirst({ where: { owner: wallet } }),
    ]);
    if (redemption !== null) {
      return { allowed: true, reason: "invite code redeemed" };
    }
    if (player !== null) {
      return { allowed: true, reason: "existing depositor" };
    }
    return { allowed: false, reason: "no invite code redeemed" };
  }

  /**
   * Verifies `signature` is `wallet`'s own ed25519 signature over
   * `accessMessage(wallet, code)` (see invite-code.ts), then spends one use
   * of `code` and binds it to `wallet`, so nobody can redeem on someone
   * else's wallet and no wallet can redeem twice.
   *
   * The use count only increments inside a conditional `updateMany` (`uses <
   * maxUses`), so two requests racing for a code's last use both run, but
   * Postgres serializes the two UPDATEs on that row: only the first commits
   * with the count still under the limit, and the second re-reads it already
   * at `maxUses` and updates zero rows. The wallet's own uniqueness is the
   * `InviteRedemption` primary key: a losing race there surfaces as a
   * Postgres unique-violation (P2002), caught below.
   *
   * When the redeemer has no Referral yet, deposited or not, this also
   * writes the `Referral` (ticket 07). Referrer
   * precedence (ADR 0014, ticket 02): a valid `referralCode` wins — it
   * exists and is not owned by the redeemer itself — otherwise the invite
   * code's owner is used, provided that owner is not the redeemer either (no
   * self-referral). It is never updated after that: a wallet redeems at most
   * once, so this branch runs at most once per referee.
   *
   * Finally, still in the same transaction, the redeemer is granted
   * `inviteGrantCount(circulation)` new single-use codes of its own
   * (ticket 07), where `circulation` is the summed remaining uses
   * (`maxUses − uses`) across every Invite code, admin-issued ones included.
   * The `pg_advisory_xact_lock` above that read serializes this section
   * across concurrent redeems, so it always counts against the latest
   * committed circulation rather than a stale snapshot: without it, two
   * requests could each see room for 2 more and both insert, overshooting
   * INVITE_CIRCULATION_CAP. A redeemed quota code's `ownerWallet` is the
   * redeemer, so a later redemption of one falls through the same
   * owner-becomes-Referrer path above.
   */
  @Post("redeem")
  async redeem(@Body() body: unknown) {
    const { wallet, code, signature, referralCode } = parseRedeemBody(body);
    if (!verifyAccessSignature(wallet, code, signature, referralCode ?? undefined)) {
      throw new BadRequestException(
        `That signature does not match "${accessMessage(wallet.toBase58(), code, referralCode ?? undefined)}".`,
      );
    }
    const address = wallet.toBase58();

    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.inviteRedemption.findUnique({ where: { wallet: address } });
        if (existing !== null) {
          throw new ConflictException("This wallet has already redeemed an invite code.");
        }
        const invite = await tx.inviteCode.findUnique({ where: { code } });
        if (invite === null) {
          throw new NotFoundException("That invite code does not exist.");
        }
        const updated = await tx.inviteCode.updateMany({
          where: { code, uses: { lt: invite.maxUses } },
          data: { uses: { increment: 1 } },
        });
        if (updated.count === 0) {
          throw new ConflictException("That invite code has no uses left.");
        }
        await tx.inviteRedemption.create({
          data: { wallet: address, code, redeemedAt: nowSeconds() },
        });

        // A wallet that applied a Referral code via POST /referrals/apply
        // before ever redeeming an invite already has a Referral row here
        // (beta-launch-fixes ticket 13): keep that earlier Referrer rather
        // than trying to insert a second one, which would hit the Referral
        // table's unique `referee` and fail this whole transaction, blocking
        // the invite redemption over a binding that already succeeded.
        const existingReferral = await tx.referral.findUnique({ where: { referee: address } });
        if (existingReferral === null) {
          let bound: { referrer: string; code: string } | null = null;
          if (referralCode !== null) {
            const owner = await tx.referralCode.findUnique({ where: { code: referralCode } });
            if (owner !== null && owner.owner !== address) {
              bound = { referrer: owner.owner, code: referralCode };
            }
          }
          if (bound === null && invite.ownerWallet !== null && invite.ownerWallet !== address) {
            bound = { referrer: invite.ownerWallet, code };
          }
          if (bound !== null) {
            await bindReferral(tx, this.poolAddress, address, bound.referrer, bound.code);
          }
        }

        // ticket 07: grant the redeemer its own quota codes, serialized
        // against every other redeem's grant so circulation never overshoots
        // INVITE_CIRCULATION_CAP (see the lock key's own comment above).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INVITE_QUOTA_LOCK_KEY}::bigint)`;
        const inCirculation = await tx.inviteCode.aggregate({
          _sum: { maxUses: true, uses: true },
        });
        const circulation = (inCirculation._sum.maxUses ?? 0) - (inCirculation._sum.uses ?? 0);
        const grantCount = inviteGrantCount(circulation, this.circulationCap, this.redeemGrantCount);
        if (grantCount > 0) {
          const grantedAt = nowSeconds();
          await tx.inviteCode.createMany({
            data: Array.from({ length: grantCount }, () => ({
              code: generateInviteCode(),
              ownerWallet: address,
              maxUses: INVITE_CODE_MAX_USES,
              uses: 0,
              createdAt: grantedAt,
            })),
          });
        }
      });
    } catch (cause) {
      if (isUniqueConstraintViolation(cause)) {
        throw new ConflictException("This wallet has already redeemed an invite code.");
      }
      throw cause;
    }

    return { allowed: true, reason: "invite code redeemed" };
  }

  /**
   * `admin create-invite` over HTTP, for whoever hands out codes without VPS
   * access. Guarded by `INVITE_ADMIN_KEY` in the `x-admin-key` header; with
   * the env var unset the route 404s as if it did not exist. Shares the
   * 10/min throttle with redeem, which also caps guessing the key.
   */
  @Post("invites")
  async createInvites(@Headers("x-admin-key") key: string | undefined, @Body() body: unknown) {
    this.requireAdminKey(key);
    const { maxUses, owner, count } = parseCreateInvitesBody(body);
    const createdAt = nowSeconds();
    const rows = Array.from({ length: count }, () => ({
      code: generateInviteCode(),
      ownerWallet: owner,
      maxUses,
      uses: 0,
      createdAt,
    }));
    await this.prisma.inviteCode.createMany({ data: rows });
    return { codes: rows.map((row) => row.code), maxUses, owner };
  }
}
